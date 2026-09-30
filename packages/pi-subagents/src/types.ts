import type { SubagentStatus } from "./status.js";

/** Fields an agent file may withhold from a spawn caller (gotgenes spelling). */
export const LOCKABLE_FIELDS = [
	"model",
	"thinking",
	"max_turns",
	"inherit_context",
	"run_in_background",
] as const;

export type LockableField = (typeof LOCKABLE_FIELDS)[number];

export function isLockableField(name: string): name is LockableField {
	return (LOCKABLE_FIELDS as readonly string[]).includes(name);
}

/**
 * An agent file's claim over caller-overridable fields.
 *
 * `true` withholds every field the file sets; a list withholds exactly the named
 * fields, whether or not the file supplies a value.
 */
export type LockDeclaration = true | readonly LockableField[];

export type PromptMode = "append" | "replace";

/** The seven Pi built-in capability tools, used when `tools` is omitted. */
export const DEFAULT_AGENT_TOOLS: readonly string[] = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

/** A resolved, frozen agent definition. Later file edits never affect it. */
export interface AgentDefinition {
	/** Agent name, derived from the definition file name (without `.md`). */
	name: string;
	/** Human-facing description from frontmatter (defaults to the name). */
	description?: string;
	/** Optional UI display name. */
	displayName?: string;
	/** Absolute path of the definition file. */
	path: string;
	/** Whether the definition came from the trusted project override directory. */
	source: "user" | "project";
	/** Complete tool allowlist (empty means none; defaults to the seven built-ins). */
	tools: readonly string[];
	/** Model string: exact `provider/modelId` or a fuzzy name. */
	model?: string;
	/** Thinking level from the gotgenes vocabulary. */
	thinking?: string;
	/** Max agentic turns; undefined or 0 means unlimited. */
	maxTurns?: number;
	/** How the definition body joins the child system prompt. */
	promptMode: PromptMode;
	/** Whether to fork the parent conversation (not supported in v1). */
	inheritContext?: boolean;
	/** Whether the agent runs in the background by default. */
	runInBackground?: boolean;
	/** Lock declaration. */
	locked?: LockDeclaration;
	/**
	 * Per-agent approved extension refs.
	 * Omitted means inherit the approved parent optional set; `[]` means none.
	 */
	extensions?: string[];
	/** Optional per-agent depth ceiling that only narrows the inherited lineage. */
	maxDepth?: number;
	/** Definition body, appended to the child's system prompt. */
	instructions: string;
	/** Whether the definition is disabled (`enabled: false`). */
	enabled: boolean;
}

/**
 * Lineage information for a session.
 *
 * The root session has depth 0. A child's depth is its parent's depth + 1.
 * `ceiling` is the deepest depth allowed anywhere in this lineage.
 */
export interface Lineage {
	/** Session id this lineage describes. */
	sessionId: string;
	/** Depth of this session, root = 0. */
	depth: number;
	/** Deepest allowed depth in this lineage (inclusive). */
	ceiling: number;
	/** Parent session id, when this is a child. */
	parentSessionId?: string;
	/** Run id of the spawn that created this session, when this is a child. */
	runId?: string;
	/** Frozen tool policy for this session. Undefined means all tools available. */
	policy?: ToolPolicy;
}

/** Frozen inclusion/exclusion policy for one admitted run. */
export interface ToolPolicy {
	/** Included names, or undefined when inclusion was omitted (all available). */
	included?: readonly string[];
	/** Excluded names, always applied last. */
	excluded: readonly string[];
}

/** Operator configuration, read from `<agentDir>/pi-subagents.json`. */
export interface OperatorConfig {
	/** Global, finite depth ceiling. Defaults to 1. */
	maxDepth: number;
	/** Approved extension refs, by operator-chosen name. */
	approvedExtensions: Record<string, string>;
	/** Approved extension refs excluded from child inheritance and selection. */
	excludedExtensions: readonly string[];
}

/** A status snapshot exposed by the result/steer tools. */
export interface RunSnapshot {
	agentId: string;
	status: SubagentStatus;
	displayName: string;
	description?: string;
	outputFile?: string;
	error?: string;
	summary?: string;
	startedAt: number;
	endedAt?: number;
}
