/**
 * Live comparison driver.
 *
 * Runs the real Pi binary in RPC mode against an isolated `PI_CODING_AGENT_DIR`
 * with one subagent extension, drives a fixed scenario, and writes the full
 * event trace plus a trimmed, fixture-ready transcript.
 *
 * Usage:
 *   bun tests/live/driver.ts mine        # this package's extension
 *   bun tests/live/driver.ts tintinweb   # @tintinweb/pi-subagents (the oracle)
 *
 * Environment (all optional):
 *   PI_BIN                     path to the pi binary
 *   PI_LIVE_DIR                scratch root (default /tmp/pi-subagents-live)
 *   PI_LIVE_BASELINE_AGENT_DIR baseline agent dir to copy provider state from
 *   PI_LIVE_PROVIDER/MODEL/THINKING
 *   PI_LIVE_TINTINWEB_EXT      extension ref for the oracle target
 *
 * This makes real, paid model calls. Run it only when explicitly asked, never
 * from an automated test or CI.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const PI =
	process.env.PI_BIN ??
	join(homedir(), ".local", "share", "path-overrides", "pi-local", "pi");
const ROOT = process.env.PI_LIVE_DIR ?? "/tmp/pi-subagents-live";
const BASELINE =
	process.env.PI_LIVE_BASELINE_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "plexus";
const MODEL = process.env.PI_LIVE_MODEL ?? "deepseek-v4.1-flash";
const THINKING = process.env.PI_LIVE_THINKING ?? "high";
const TINTINWEB_EXT =
	process.env.PI_LIVE_TINTINWEB_EXT ?? "npm:@tintinweb/pi-subagents";
const MINE_EXT = process.env.PI_LIVE_MINE_EXT ?? join(PACKAGE_ROOT, "index.ts");
const PROBE_EXT = join(HERE, "probe.ts");

type Rec = Record<string, unknown> & { _t?: number };

interface Target {
	agentDir: string;
	extension: string;
	tool: string;
}

/** Scenario prompts. Keep these exact: the recorded fixtures depend on them. */
function scenario(tool: string) {
	return {
		background: `Call the ${tool} tool exactly once with these arguments: ${JSON.stringify(
			{
				subagent_type: "explore",
				prompt:
					"Reply with exactly the word pong and nothing else. Do not call any tool.",
				description: "cmp background",
				run_in_background: true,
			},
		)}. After the tool returns, reply with the single word DONE and stop.`,
		foreground: `Call the ${tool} tool exactly once with these arguments: ${JSON.stringify(
			{
				subagent_type: "explore",
				prompt:
					"Reply with exactly the word pong and nothing else. Do not call any tool.",
				description: "cmp foreground",
				run_in_background: false,
			},
		)}. After the tool returns, reply with the single word DONE and stop.`,
		badType: `Call the ${tool} tool exactly once with these arguments: ${JSON.stringify(
			{
				subagent_type: "does-not-exist",
				prompt: "x",
				description: "cmp bad type",
			},
		)}. Then reply with the single word DONE and stop.`,
		followup:
			"Call the get_subagent_result tool exactly once, using the agent_id from the earlier background agent result, with wait: true. Then reply with the single word DONE and stop.",
	};
}

/** The subset of RPC records the fixtures and comparator care about. */
const FIXTURE_TYPES = new Set([
	"tool_execution_start",
	"tool_execution_end",
	"message_end",
	"response",
]);

function fixtureRecords(records: Rec[]): Rec[] {
	return records.filter((record) => {
		if (record.type === "extension_ui_request")
			return record.method === "notify";
		if (record.type === "response") return record.command === "prompt";
		if (record.type === "message_end")
			return (record.message as Rec | undefined)?.role === "custom";
		return FIXTURE_TYPES.has(String(record.type));
	});
}

// ---------------------------------------------------------------------------
// Isolated agent dir
// ---------------------------------------------------------------------------

function copyIfPresent(src: string, dest: string): void {
	if (!existsSync(src)) return;
	cpSync(src, dest, { recursive: true });
}

function prepareAgentDir(label: string): string {
	const agentDir = join(ROOT, label, "agent");
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(ROOT, label, "sessions"), { recursive: true });

	copyIfPresent(
		join(BASELINE, "settings.json"),
		join(agentDir, "settings.json"),
	);
	copyIfPresent(join(BASELINE, "auth.json"), join(agentDir, "auth.json"));
	copyIfPresent(
		join(BASELINE, "models-store.json"),
		join(agentDir, "models-store.json"),
	);
	copyIfPresent(join(BASELINE, "extensions"), join(agentDir, "extensions"));
	const agentsDir = join(BASELINE, "agents");
	if (existsSync(agentsDir)) {
		for (const file of readdirSync(agentsDir).filter((entry) =>
			entry.endsWith(".md"),
		)) {
			cpSync(join(agentsDir, file), join(agentDir, "agents", file));
		}
	}
	// Keep the run focused: no MCP servers, no scheduling defaults.
	writeFileSync(join(agentDir, "mcp.json"), '{"mcpServers":{}}\n');
	writeFileSync(
		join(agentDir, "pi-subagents.json"),
		'{"maxDepth":1,"approvedExtensions":{}}\n',
	);
	writeFileSync(
		join(agentDir, "subagents.json"),
		'{"maxConcurrent":4,"abortAllOnInterrupt":false}\n',
	);
	for (const cache of ["npm", "packages"]) {
		const src = join(BASELINE, cache);
		if (!existsSync(src)) continue;
		try {
			symlinkSync(src, join(agentDir, cache));
		} catch {
			// Already linked.
		}
	}
	return agentDir;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

interface Waiter {
	pred: (r: Rec) => boolean;
	from: number;
	resolve: (value: { index: number; rec: Rec } | undefined) => void;
}

class Rpc {
	readonly records: Rec[] = [];
	private readonly waiters = new Set<Waiter>();
	private buf = "";

	constructor(
		readonly proc: Bun.Subprocess,
		private readonly sink: Rec[],
	) {
		void this.pump();
	}

	get stdin() {
		return this.proc.stdin as import("bun").FileSink;
	}

	private async pump(): Promise<void> {
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			this.buf += decoder.decode(value, { stream: true });
			for (;;) {
				const newline = this.buf.indexOf("\n");
				if (newline < 0) break;
				let line = this.buf.slice(0, newline);
				this.buf = this.buf.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line.trim()) continue;
				let record: Rec;
				try {
					record = JSON.parse(line) as Rec;
				} catch {
					continue;
				}
				record._t = Date.now();
				this.records.push(record);
				this.sink.push(record);
				this.check();
			}
		}
		this.check();
	}

	private check(): void {
		for (const waiter of [...this.waiters]) {
			for (let i = waiter.from; i < this.records.length; i++) {
				if (waiter.pred(this.records[i])) {
					this.waiters.delete(waiter);
					waiter.resolve({ index: i, rec: this.records[i] });
					break;
				}
			}
		}
	}

	send(record: Record<string, unknown>): void {
		this.stdin.write(`${JSON.stringify(record)}\n`);
		this.stdin.flush();
	}

	waitFor(
		pred: (record: Rec) => boolean,
		options: { from?: number; timeoutMs?: number } = {},
	): Promise<{ index: number; rec: Rec } | undefined> {
		const from = options.from ?? 0;
		for (let i = from; i < this.records.length; i++) {
			if (pred(this.records[i]))
				return Promise.resolve({ index: i, rec: this.records[i] });
		}
		return new Promise((resolvePromise) => {
			const waiter: Waiter = { pred, from, resolve: () => {} };
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				resolvePromise(undefined);
			}, options.timeoutMs ?? 120_000);
			waiter.resolve = (value) => {
				clearTimeout(timer);
				resolvePromise(value);
			};
			this.waiters.add(waiter);
		});
	}

	get length(): number {
		return this.records.length;
	}
}

const isResponse = (id: string) => (record: Rec) =>
	record.type === "response" && record.id === id;
const isSettled = (record: Rec) => record.type === "agent_settled";
const isNotification = (record: Rec) => {
	const message = record.message as Rec | undefined;
	return (
		record.type === "message_end" &&
		message?.role === "custom" &&
		(message.customType === "subagent-notification" ||
			message.customType === "subagent-update")
	);
};

async function waitIdle(rpc: Rpc, timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const id = `idle-${rpc.length}-${Date.now()}`;
		const from = rpc.length;
		rpc.send({ id, type: "get_state" });
		const response = await rpc.waitFor(isResponse(id), {
			from,
			timeoutMs: 15_000,
		});
		const data = response?.rec.data as { isStreaming?: boolean } | undefined;
		if (data?.isStreaming === false) return;
		if (Date.now() > deadline) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
	}
}

async function sendPrompt(
	rpc: Rpc,
	id: string,
	message: string,
): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		await waitIdle(rpc);
		const from = rpc.length;
		rpc.send({ id, type: "prompt", message });
		const accepted = await rpc.waitFor(isResponse(id), {
			from,
			timeoutMs: 30_000,
		});
		if (accepted?.rec.success) {
			await rpc.waitFor(isSettled, { from });
			return;
		}
	}
	throw new Error(`prompt ${id} was not accepted`);
}

async function runScenario(label: string, target: Target): Promise<void> {
	const prompts = scenario(target.tool);
	const sessionId = `cmp-${label}-${Date.now().toString(36)}`;
	const proc = Bun.spawn(
		[
			PI,
			"--mode",
			"rpc",
			"--provider",
			PROVIDER,
			"--model",
			MODEL,
			"--thinking",
			THINKING,
			"--session-id",
			sessionId,
			"--session-dir",
			join(ROOT, label, "sessions"),
			"--name",
			`cmp-${label}`,
			"--no-skills",
			"--no-themes",
			"--no-context-files",
			"--extension",
			PROBE_EXT,
			"--extension",
			target.extension,
		],
		{
			env: { ...process.env, PI_CODING_AGENT_DIR: target.agentDir },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	const stderrChunks: string[] = [];
	void (async () => {
		const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			stderrChunks.push(decoder.decode(value, { stream: true }));
		}
	})();

	const sink: Rec[] = [];
	const rpc = new Rpc(proc, sink);

	try {
		await sendPrompt(rpc, "bg-1", prompts.background);
		await rpc.waitFor(isNotification, { timeoutMs: 90_000 });
		await sendPrompt(rpc, "fg-1", prompts.foreground);
		await rpc.waitFor(isNotification, { timeoutMs: 60_000 });
		await sendPrompt(rpc, "bad-1", prompts.badType);
		await sendPrompt(rpc, "fu-1", prompts.followup);
	} catch (error) {
		console.error(
			`[${label}] scenario error:`,
			error instanceof Error ? error.message : error,
		);
	} finally {
		try {
			rpc.stdin.end();
		} catch {
			// stdin already closed.
		}
		const exited = await Promise.race([
			proc.exited.then(() => true),
			new Promise<boolean>((resolvePromise) =>
				setTimeout(() => resolvePromise(false), 5_000),
			),
		]);
		if (!exited) {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}

	const dir = join(ROOT, label);
	writeFileSync(
		join(dir, `${label}.trace.jsonl`),
		`${sink.map((record) => JSON.stringify(record)).join("\n")}\n`,
	);
	writeFileSync(
		join(dir, `${label}-rpc.jsonl`),
		`${fixtureRecords(sink)
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`,
	);
	writeFileSync(join(dir, `${label}.stderr.log`), stderrChunks.join(""));
}

const label = process.argv[2] ?? "mine";
if (label !== "mine" && label !== "tintinweb") {
	console.error(`unknown target "${label}"; expected "mine" or "tintinweb"`);
	process.exit(2);
}
const target: Target = {
	agentDir: prepareAgentDir(label),
	extension: label === "mine" ? MINE_EXT : TINTINWEB_EXT,
	tool: "Agent",
};
await runScenario(label, target);
console.log(
	JSON.stringify({ label, trace: join(ROOT, label, `${label}.trace.jsonl`) }),
);
process.exit(0);
