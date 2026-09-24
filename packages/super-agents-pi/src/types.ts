import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface SuperAgentsConfig {
	maxConcurrent: number; // default 8
	maxTasksPerCall: number; // default 8
	graceTurns: number; // default 3
	maxResultBytes: number; // default 65536
	maxEventBytes: number; // default 65536
	events: {
		enabled: boolean; // default true
	};
	overflowDir?: string; // default undefined → os.tmpdir()/super-agents-pi
}

export type ExtensionsSpec = "none" | "all" | string[];
export type SkillsSpec = "none" | "all" | string[];

export interface AgentDefinition {
	slug: string; // filename without .md
	displayName: string; // display_name ?? slug
	description: string; // required, single line after trimming/collapsing whitespace
	body: string; // markdown body (trimmed); may be ""
	tools: string[]; // resolved allowlist (DEFAULT_TOOLS if omitted)
	excludeTools: string[]; // default []
	extensions: ExtensionsSpec; // default "none"
	excludeExtensions: string[]; // default []; only meaningful with extensions: "all"
	skills: SkillsSpec; // default "none"
	contextFiles: boolean; // default false
	systemPromptMode: "append" | "replace"; // default "append"
	model?: string; // "provider/modelId"
	thinking?: ThinkingLevel;
	allowModelOverride: boolean; // default false
	maxTurns?: number; // positive integer; undefined = unlimited
	source: "user" | "project";
	filePath: string;
}

export interface AgentLoadResult {
	agents: AgentDefinition[]; // sorted by slug
	errors: Array<{ filePath: string; message: string }>;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "turn_limited";

export interface TaskInput {
	agent: string;
	prompt: string;
	name?: string;
	model?: string;
	thinking?: ThinkingLevel;
}

export interface RunUsage {
	turns: number;
	toolCalls: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
}

export interface RunRecord {
	id: string; // e.g. "a7k2m9qz" (8 chars [a-z0-9]); THE id — no short/long forms
	name: string; // instance name, unique among non-finished runs
	slug: string;
	prompt: string;
	background: boolean;
	parentToolCallId: string;
	status: RunStatus;
	model?: string; // "provider/id" actually used
	thinking?: ThinkingLevel;
	overrideIgnored?: boolean; // task asked for model/thinking but agent disallows overrides
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	resultText?: string; // full final text (kept in memory until delivered)
	outputPath?: string; // overflow file if written
	error?: string;
	usage?: RunUsage;
	delivered: boolean; // result consumed by agent_wait / foreground return / background push
}
