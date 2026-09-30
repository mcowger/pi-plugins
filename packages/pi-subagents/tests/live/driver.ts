/**
 * Live comparison driver.
 *
 * Runs the real Pi binary in RPC mode against an isolated `PI_CODING_AGENT_DIR`
 * with one subagent extension and drives one named scenario, writing the full
 * event trace plus a trimmed, fixture-ready transcript.
 *
 * Usage:
 *   bun tests/live/driver.ts <mine|tintinweb> [scenario]
 *
 * Scenarios:
 *   contract    background/foreground/bad-type/followup (default)
 *   nested      child spawns a grandchild (this extension only)
 *   concurrent  three background children in one turn
 *   steer       steer a running background child
 *   error       child against a faulty provider (foreground + background)
 *   abort       child that hard-aborts on its turn limit
 *   mcp         real mcp.json + frozen tool policy incl. codemode-nested
 *   shutdown    spawn a long child, then close stdin
 *
 * Environment: see ../../AGENTS.md.
 *
 * This makes real, paid model calls. Run it only when explicitly asked, never
 * from an automated test or CI.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
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
const FAULT_EXT = join(HERE, "fault-provider.ts");
const TEST_AGENTS = join(HERE, "agents");

type Rec = Record<string, unknown> & { _t?: number };

interface Target {
	label: string;
	agentDir: string;
	extension: string;
	tool: string;
	scenario: string;
}

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

function prepareAgentDir(label: string, scenario: string): string {
	const agentDir = join(ROOT, label, scenario, "agent");
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(join(ROOT, label, scenario, "sessions"), { recursive: true });
	rmSync(join(ROOT, label, scenario, "probe.jsonl"), { force: true });

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
	for (const file of readdirSync(TEST_AGENTS).filter((entry) =>
		entry.endsWith(".md"),
	)) {
		cpSync(join(TEST_AGENTS, file), join(agentDir, "agents", file));
	}
	// Fault provider must be discoverable so both parent and child load it.
	cpSync(FAULT_EXT, join(agentDir, "extensions", "fault-provider.ts"));
	// Probe lives in the agent dir so the child loads it too and records its
	// policy-filtered tool set.
	cpSync(PROBE_EXT, join(agentDir, "extensions", "probe.ts"));

	if (scenario === "mcp" || scenario === "policy") {
		copyIfPresent(join(BASELINE, "mcp.json"), join(agentDir, "mcp.json"));
	} else {
		writeFileSync(join(agentDir, "mcp.json"), '{"mcpServers":{}}\n');
	}
	const maxDepth = scenario === "nested" ? 2 : 1;
	writeFileSync(
		join(agentDir, "pi-subagents.json"),
		`${JSON.stringify({ maxDepth, approvedExtensions: {} })}\n`,
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
			}, options.timeoutMs ?? 30_000);
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
const isToolEnd = (tool: string) => (record: Rec) =>
	record.type === "tool_execution_end" && record.toolName === tool;
const isNotification = (record: Rec) => {
	const message = record.message as Rec | undefined;
	return (
		record.type === "message_end" &&
		message?.role === "custom" &&
		(message.customType === "subagent-notification" ||
			message.customType === "subagent-update")
	);
};

const sleep = (ms: number) =>
	new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitIdle(rpc: Rpc, timeoutMs = 60_000): Promise<void> {
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
		await sleep(500);
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

async function waitNotifications(
	rpc: Rpc,
	count: number,
	timeoutMs: number,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (rpc.records.filter(isNotification).length < count) {
		if (Date.now() > deadline) break;
		await sleep(500);
	}
	return rpc.records.filter(isNotification).length;
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

function agentArgs(args: unknown): string {
	return JSON.stringify(args);
}

function spawnInstruction(tool: string, args: Record<string, unknown>): string {
	return `Call the ${tool} tool exactly once with these arguments: ${agentArgs(args)}.`;
}

function childOutputFile(record: Rec): string | undefined {
	const content = (record.result as Rec | undefined)?.content as
		| Array<{ text?: string }>
		| undefined;
	const match = content?.[0]?.text?.match(/^Output file:\s*(\S+)$/m);
	return match?.[1];
}

/** Read a child's session JSONL and return the tool names and result text it used. */
function readChildTranscript(path: string | undefined): {
	toolNames: string[];
	text: string;
} {
	if (!path || !existsSync(path)) return { toolNames: [], text: "" };
	const raw = readFileSync(path, "utf8");
	const toolNames: string[] = [];
	for (const match of raw.matchAll(/"toolName":"([^"]+)"/g))
		toolNames.push(match[1]);
	return { toolNames: [...new Set(toolNames)], text: raw };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenario = scenarioName();

function scenarioName(): string {
	const arg = process.argv[3] ?? "contract";
	return arg;
}

async function runContract(rpc: Rpc, tool: string): Promise<void> {
	await sendPrompt(
		rpc,
		"bg-1",
		`${spawnInstruction(tool, {
			subagent_type: "explore",
			prompt:
				"Reply with exactly the word pong and nothing else. Do not call any tool.",
			description: "cmp background",
			run_in_background: true,
		})} After the tool returns, reply with the single word DONE and stop.`,
	);
	await rpc.waitFor(isNotification, { timeoutMs: 30_000 });
	await sendPrompt(
		rpc,
		"fg-1",
		`${spawnInstruction(tool, {
			subagent_type: "explore",
			prompt:
				"Reply with exactly the word pong and nothing else. Do not call any tool.",
			description: "cmp foreground",
			run_in_background: false,
		})} After the tool returns, reply with the single word DONE and stop.`,
	);
	await rpc.waitFor(isNotification, { timeoutMs: 60_000 });
	await sendPrompt(
		rpc,
		"bad-1",
		`${spawnInstruction(tool, {
			subagent_type: "does-not-exist",
			prompt: "x",
			description: "cmp bad type",
		})} Then reply with the single word DONE and stop.`,
	);
	await sendPrompt(
		rpc,
		"fu-1",
		"Call the get_subagent_result tool exactly once, using the agent_id from the earlier background agent result, with wait: true. Then reply with the single word DONE and stop.",
	);
}

async function runNested(rpc: Rpc, tool: string): Promise<void> {
	await sendPrompt(
		rpc,
		"nested-1",
		`${spawnInstruction(tool, {
			subagent_type: "nested",
			prompt: "Spawn your own child now.",
			description: "nested root",
			run_in_background: true,
		})} After the tool returns, reply with the single word DONE and stop.`,
	);
	await waitNotifications(rpc, 1, 30_000);
	await waitIdle(rpc, 30_000);
}

async function runConcurrent(rpc: Rpc, tool: string): Promise<void> {
	const calls = [1, 2, 3].map((n) => ({
		subagent_type: "sleeper",
		prompt: `Run bash with command 'sleep 6' and then reply with the single word pong-${n}.`,
		description: `conc ${n}`,
		run_in_background: true,
	}));
	await sendPrompt(
		rpc,
		"conc-1",
		`Call the ${tool} tool exactly three times in this one message, once per argument set, in parallel: ${agentArgs(calls)}. Do not call any other tool. After the three Agent calls return, reply with the single word DONE and stop immediately.`,
	);
	await waitNotifications(rpc, 1, 30_000);
	await waitIdle(rpc, 30_000);
}

async function runSteer(rpc: Rpc, tool: string): Promise<void> {
	await sendPrompt(
		rpc,
		"steer-1",
		`${spawnInstruction(tool, {
			subagent_type: "sleeper",
			prompt:
				"Run bash with command 'sleep 45', then reply with the single word pong.",
			description: "steer target",
			run_in_background: true,
		})} After the tool returns, reply with the single word DONE and stop.`,
	);
	await rpc.waitFor(isToolEnd(tool), { timeoutMs: 30_000 });
	await sleep(5_000);
	await sendPrompt(
		rpc,
		"steer-2",
		"Call the steer_subagent tool exactly once with the agent_id from the background Agent result and message 'Stop sleeping and reply with the single word pong immediately.' Then reply with the single word DONE and stop.",
	);
	await waitNotifications(rpc, 1, 30_000);
	await waitIdle(rpc, 30_000);
}

async function runError(rpc: Rpc, tool: string): Promise<void> {
	await sendPrompt(
		rpc,
		"error-fg",
		`${spawnInstruction(tool, {
			subagent_type: "faulty",
			prompt: "Say hi.",
			description: "faulty foreground",
			run_in_background: false,
		})} Then reply with the single word DONE and stop.`,
	);
	await sendPrompt(
		rpc,
		"error-bg",
		`${spawnInstruction(tool, {
			subagent_type: "faulty",
			prompt: "Say hi.",
			description: "faulty background",
			run_in_background: true,
		})} Then reply with the single word DONE and stop.`,
	);
	await waitNotifications(rpc, 1, 30_000);
	await waitIdle(rpc, 30_000);
}

async function runAbort(rpc: Rpc, tool: string): Promise<void> {
	await sendPrompt(
		rpc,
		"abort-1",
		`${spawnInstruction(tool, {
			subagent_type: "looper",
			prompt: "Loop forever.",
			description: "abort target",
			run_in_background: true,
		})} After the tool returns, reply with the single word DONE and stop.`,
	);
	await waitNotifications(rpc, 1, 40_000);
	await waitIdle(rpc, 40_000);
}

async function runMcp(rpc: Rpc, tool: string): Promise<void> {
	await sendPrompt(
		rpc,
		"mcp-1",
		`${spawnInstruction(tool, {
			subagent_type: "prober",
			prompt:
				"Do all three and report each outcome: (1) call the tool mcp__exa__web_search_exa with query 'hello'; (2) try to call the tool mcp__exa__web_fetch_exa directly with url 'https://example.com'; (3) use the codemode tool to call mcp__exa__web_fetch_exa with url 'https://example.com'. End your reply with the single word pong.",
			description: "mcp policy probe",
			run_in_background: true,
			included_tools: ["codemode", "mcp__exa__web_search_exa"],
			excluded_tools: ["mcp__exa__web_fetch_exa"],
		})} After the tool returns, reply with the single word DONE and stop.`,
	);
	await waitNotifications(rpc, 1, 40_000);
	await waitIdle(rpc, 40_000);
}

async function runPolicy(rpc: Rpc, tool: string): Promise<void> {
	// `explore` declares only read,bash,grep,find,ls; with real MCP configured the
	// child must not gain codemode/tool_search/MCP tools anyway.
	await sendPrompt(
		rpc,
		"policy-1",
		`${spawnInstruction(tool, {
			subagent_type: "explore",
			prompt:
				"Reply with exactly the word pong and nothing else. Do not call any tool.",
			description: "policy probe",
			run_in_background: true,
		})} After the tool returns, reply with the single word DONE and stop.`,
	);
	await waitNotifications(rpc, 1, 30_000);
	await waitIdle(rpc, 30_000);
}

async function runShutdown(rpc: Rpc, tool: string): Promise<void> {
	await sendPrompt(
		rpc,
		"shutdown-1",
		`${spawnInstruction(tool, {
			subagent_type: "sleeper",
			prompt: "Run bash with command 'sleep 300'.",
			description: "shutdown target",
			run_in_background: true,
		})} After the tool returns, reply with the single word DONE and stop.`,
	);
	await rpc.waitFor(isToolEnd(tool), { timeoutMs: 30_000 });
	await sleep(3_000);
}

async function runScenario(rpc: Rpc, target: Target): Promise<void> {
	switch (target.scenario) {
		case "nested":
			return runNested(rpc, target.tool);
		case "concurrent":
			return runConcurrent(rpc, target.tool);
		case "steer":
			return runSteer(rpc, target.tool);
		case "error":
			return runError(rpc, target.tool);
		case "abort":
			return runAbort(rpc, target.tool);
		case "mcp":
			return runMcp(rpc, target.tool);
		case "policy":
			return runPolicy(rpc, target.tool);
		case "shutdown":
			return runShutdown(rpc, target.tool);
		default:
			return runContract(rpc, target.tool);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const label = process.argv[2] ?? "mine";
if (label !== "mine" && label !== "tintinweb") {
	console.error(`unknown target "${label}"; expected "mine" or "tintinweb"`);
	process.exit(2);
}
const target: Target = {
	label,
	agentDir: prepareAgentDir(label, scenario),
	extension: label === "mine" ? MINE_EXT : TINTINWEB_EXT,
	tool: "Agent",
	scenario,
};

const sessionId = `cmp-${label}-${scenario}-${Date.now().toString(36)}`;
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
		join(ROOT, label, scenario, "sessions"),
		"--name",
		`cmp-${label}-${scenario}`,
		"--no-skills",
		"--no-themes",
		"--no-context-files",
		"--extension",
		target.extension,
	],
	{
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: target.agentDir,
			PI_LIVE_PROBE_FILE: join(ROOT, label, scenario, "probe.jsonl"),
		},
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
	await runScenario(rpc, target);
} catch (error) {
	console.error(
		`[${label}/${scenario}] scenario error:`,
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
			setTimeout(() => resolvePromise(false), 8_000),
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

const dir = join(ROOT, label, scenario);
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

// Summaries for the narrower scenarios, so findings are visible without jq.
if (scenario === "nested" || scenario === "shutdown") {
	for (const record of sink.filter(isNotification)) {
		const details = (record.message as Rec).details as Rec;
		const output = details?.outputFile as string | undefined;
		const child = readChildTranscript(output);
		console.error(
			`[${label}/${scenario}] notification id=${details?.id} status=${details?.status} childTools=${child.toolNames.join(",")}`,
		);
	}
}
if (
	stderrChunks
		.join("")
		.match(/already registered|tool name conflict|duplicate tool/i)
) {
	console.error(`[${label}/${scenario}] extension conflict detected in stderr`);
}

console.log(
	JSON.stringify({ label, scenario, trace: join(dir, `${label}.trace.jsonl`) }),
);
process.exit(0);
