interface Waiter {
	resolve: (release: () => void) => void;
	reject: (err: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

function abortError(): Error {
	const err = new Error("aborted");
	err.name = "AbortError";
	return err;
}

export class Semaphore {
	#max: number;
	#running = 0;
	#queue: Waiter[] = [];

	constructor(max: number) {
		this.#max = max;
	}

	get running(): number {
		return this.#running;
	}

	get queued(): number {
		return this.#queue.length;
	}

	setMax(max: number): void {
		this.#max = max;
		this.#drain();
	}

	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) {
			return Promise.reject(abortError());
		}

		return new Promise<() => void>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal };
			if (signal) {
				const onAbort = () => {
					const idx = this.#queue.indexOf(waiter);
					if (idx !== -1) {
						this.#queue.splice(idx, 1);
						reject(abortError());
					}
				};
				waiter.onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.#queue.push(waiter);
			this.#drain();
		});
	}

	#drain(): void {
		while (this.#running < this.#max && this.#queue.length > 0) {
			const waiter = this.#queue.shift();
			if (!waiter) break;
			if (waiter.signal && waiter.onAbort) {
				waiter.signal.removeEventListener("abort", waiter.onAbort);
			}
			this.#running += 1;
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				this.#running -= 1;
				this.#drain();
			};
			waiter.resolve(release);
		}
	}
}
