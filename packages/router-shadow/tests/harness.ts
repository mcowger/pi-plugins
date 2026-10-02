import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import routerShadow from "../src/index.js";

export type Handler = (event: never, ctx: never) => unknown;
export type CommandHandler = (
	args: string,
	ctx: never,
) => Promise<unknown> | unknown;

export interface FakeUi {
	notify: (message: string, type?: string) => void;
	setStatus: (key: string, text: string | undefined) => void;
	notices: { message: string; type?: string }[];
	statuses: { key: string; text: string | undefined }[];
}

export interface BranchEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: { role: string; content: unknown };
}

export interface Harness {
	pi: ExtensionAPI;
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: CommandHandler }>;
	ui: FakeUi;
	logDir: string;
	sessionManager: {
		getBranch: () => BranchEntry[];
		getSessionId: () => string;
		getSessionFile: () => string;
		getHeader: () => { parentSession?: string } | null;
		getCwd: () => string;
	};
	appended: { customType: string; data?: unknown }[];
	fire: (event: string, payload: unknown, ctx?: unknown) => unknown;
	runCommand: (name: string, args: string, ctx?: unknown) => Promise<unknown>;
	ctx: (overrides?: Record<string, unknown>) => Record<string, unknown>;
}

export async function makeHarness(options?: {
	header?: { parentSession?: string } | null;
	branch?: BranchEntry[];
	settings?: Record<string, unknown>;
}): Promise<Harness> {
	const logDir = await mkdtemp(join(tmpdir(), "router-shadow-"));
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const appended: Harness["appended"] = [];
	const notices: FakeUi["notices"] = [];
	const statuses: FakeUi["statuses"] = [];
	const ui: FakeUi = {
		notify: (message, type) => {
			notices.push({ message, type });
		},
		setStatus: (key, text) => {
			statuses.push({ key, text });
		},
		notices,
		statuses,
	};
	const sessionManager = {
		getBranch: () => options?.branch ?? [],
		getSessionId: () => "session-1",
		getSessionFile: () => join(logDir, "session.jsonl"),
		getHeader: () => options?.header ?? null,
		getCwd: () => "/work",
	};
	const baseCtx = {
		ui,
		cwd: "/work",
		model: { id: "gpt-6-luna", provider: "plexus" },
		thinkingLevel: "high",
		sessionManager,
		modelRegistry: {
			getApiKeyForProvider: async (_provider: string) => undefined,
		},
	};
	const harness: Harness = {
		pi: {
			on: ((event: string, handler: Handler) => {
				handlers.set(event, handler);
				return () => {
					handlers.delete(event);
				};
			}) as unknown as ExtensionAPI["on"],
			registerCommand: ((
				name: string,
				options: { handler: CommandHandler },
			) => {
				commands.set(name, options);
			}) as unknown as ExtensionAPI["registerCommand"],
			appendEntry: ((customType: string, data?: unknown) => {
				appended.push({ customType, data });
			}) as unknown as ExtensionAPI["appendEntry"],
			getSettings: (() => ({
				routerShadow: {
					logDir,
					apiBase: "https://plexus.example",
					apiKey: "test-key",
					...(options?.settings ?? {}),
				},
			})) as unknown as ExtensionAPI["getSettings"],
			events: {
				on: () => () => {},
				emit: () => {},
			} as unknown as ExtensionAPI["events"],
		} as unknown as ExtensionAPI,
		handlers,
		commands,
		ui,
		logDir,
		sessionManager,
		appended,
		fire: (event, payload, ctx) =>
			handlers.get(event)?.(payload as never, (ctx ?? baseCtx) as never),
		runCommand: (name, args, ctx) => {
			const command = commands.get(name);
			if (!command)
				return Promise.reject(new Error(`no such command: ${name}`));
			return Promise.resolve(command.handler(args, (ctx ?? baseCtx) as never));
		},
		ctx: (overrides) => ({ ...baseCtx, ...overrides }),
	};
	await routerShadow(harness.pi);
	await harness.fire("session_start", { type: "session_start" });
	return harness;
}

export function jevBody(tier: string) {
	return {
		answers: {
			tier: {
				type: "choice",
				choice: tier,
				probabilities: {
					economy: 0.6,
					standard: 0.3,
					high: 0.07,
					premium: 0.03,
				},
				confidence: 0.55,
			},
		},
		usage: { input_tokens: 200, cost: 0.00001 },
	};
}

export function userBranch(prompt: string): BranchEntry[] {
	return [
		{
			type: "message",
			id: "u1",
			parentId: null,
			message: { role: "user", content: [{ type: "text", text: prompt }] },
		},
	];
}

export async function readRecords(
	logDir: string,
): Promise<Record<string, unknown>[]> {
	const files = (await readdir(logDir)).filter((f) =>
		f.startsWith("decisions-"),
	);
	const out: Record<string, unknown>[] = [];
	for (const file of files) {
		const text = await readFile(join(logDir, file), "utf8");
		for (const line of text.split("\n")) {
			if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
		}
	}
	return out;
}

export async function waitForRecords(
	logDir: string,
	count: number,
	timeoutMs: number,
): Promise<Record<string, unknown>[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const records = await readRecords(logDir);
		if (records.length >= count) return records;
		if (Date.now() >= deadline) return records;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
