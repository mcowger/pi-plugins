import { describe, expect, it } from "bun:test";
import { Semaphore } from "../src/semaphore.ts";

describe("Semaphore", () => {
	it("grants immediately while under the max, and tracks running/queued", async () => {
		const sem = new Semaphore(2);
		expect(sem.running).toBe(0);
		expect(sem.queued).toBe(0);

		const release1 = await sem.acquire();
		expect(sem.running).toBe(1);
		const release2 = await sem.acquire();
		expect(sem.running).toBe(2);

		let thirdGranted = false;
		const third = sem.acquire().then((release) => {
			thirdGranted = true;
			return release;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(thirdGranted).toBe(false);
		expect(sem.queued).toBe(1);

		release1();
		const release3 = await third;
		expect(thirdGranted).toBe(true);
		expect(sem.running).toBe(2);
		expect(sem.queued).toBe(0);

		release2();
		release3();
		expect(sem.running).toBe(0);
	});

	it("respects the max: never grants more than max concurrently", async () => {
		const sem = new Semaphore(3);
		const releases: Array<() => void> = [];
		for (let i = 0; i < 3; i++) releases.push(await sem.acquire());
		expect(sem.running).toBe(3);

		let granted = false;
		void sem.acquire().then((r) => {
			granted = true;
			releases.push(r);
		});
		await Promise.resolve();
		expect(granted).toBe(false);

		releases.shift()?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(granted).toBe(true);
		expect(sem.running).toBe(3);
	});

	it("grants queued waiters in strict FIFO order", async () => {
		const sem = new Semaphore(1);
		const release1 = await sem.acquire();

		const order: number[] = [];
		const p2 = sem.acquire().then((r) => {
			order.push(2);
			return r;
		});
		const p3 = sem.acquire().then((r) => {
			order.push(3);
			return r;
		});
		const p4 = sem.acquire().then((r) => {
			order.push(4);
			return r;
		});

		release1();
		const release2 = await p2;
		release2();
		const release3 = await p3;
		release3();
		const release4 = await p4;
		release4();

		expect(order).toEqual([2, 3, 4]);
	});

	it("removes an aborted waiter from the queue and rejects with AbortError; it never resolves or occupies a slot", async () => {
		const sem = new Semaphore(1);
		const release1 = await sem.acquire();

		const controller = new AbortController();
		const pending = sem.acquire(controller.signal);
		expect(sem.queued).toBe(1);

		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(sem.queued).toBe(0);

		// Releasing the held slot must not resolve the aborted waiter and must
		// simply leave the semaphore idle (nothing left in the queue).
		release1();
		expect(sem.running).toBe(0);
		expect(sem.queued).toBe(0);
	});

	it("rejects immediately if the signal is already aborted before acquire is called", async () => {
		const sem = new Semaphore(1);
		const controller = new AbortController();
		controller.abort();
		await expect(sem.acquire(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(sem.queued).toBe(0);
		expect(sem.running).toBe(0);
	});

	it("release is idempotent: calling it twice does not free two slots", async () => {
		const sem = new Semaphore(1);
		const release1 = await sem.acquire();
		release1();
		release1();
		expect(sem.running).toBe(0);

		const release2 = await sem.acquire();
		expect(sem.running).toBe(1);
		release2();
		expect(sem.running).toBe(0);
	});

	it("setMax increasing drains the queue immediately", async () => {
		const sem = new Semaphore(1);
		const release1 = await sem.acquire();

		let granted2 = false;
		let granted3 = false;
		void sem.acquire().then((r) => {
			granted2 = true;
			return r;
		});
		void sem.acquire().then((r) => {
			granted3 = true;
			return r;
		});
		expect(sem.queued).toBe(2);

		sem.setMax(3);
		await Promise.resolve();
		await Promise.resolve();

		expect(granted2).toBe(true);
		expect(granted3).toBe(true);
		expect(sem.queued).toBe(0);
		expect(sem.running).toBe(3);
		release1();
	});

	it("setMax decreasing does not evict running holders, just stops granting new ones until back under the cap", async () => {
		const sem = new Semaphore(2);
		const release1 = await sem.acquire();
		const release2 = await sem.acquire();
		expect(sem.running).toBe(2);

		sem.setMax(1);
		expect(sem.running).toBe(2); // running holders are not forcibly evicted

		let granted = false;
		void sem.acquire().then((r) => {
			granted = true;
			return r;
		});
		await Promise.resolve();
		expect(granted).toBe(false);

		release1();
		await Promise.resolve();
		expect(granted).toBe(false); // still at/over the new cap (1 running)
		expect(sem.running).toBe(1);

		release2();
		await Promise.resolve();
		expect(granted).toBe(true);
		expect(sem.running).toBe(1);
	});
});
