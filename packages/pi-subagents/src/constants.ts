/**
 * Shared constants for the pi-subagents extension.
 *
 * The tool names are part of the Paseo `@tintinweb/pi-subagents` adapter's wire
 * contract: Paseo dispatches exactly `Agent`, `get_subagent_result`, and
 * `steer_subagent`.
 */

export const AGENT_TOOL_NAME = "Agent";
export const GET_RESULT_TOOL_NAME = "get_subagent_result";
export const STEER_TOOL_NAME = "steer_subagent";

export const SPAWNER_TOOL_NAMES: readonly string[] = [
	AGENT_TOOL_NAME,
	GET_RESULT_TOOL_NAME,
	STEER_TOOL_NAME,
];

/** Custom message types the Paseo adapter accepts. */
export const SUBAGENT_UPDATE_TYPE = "subagent-update";
export const SUBAGENT_NOTIFICATION_TYPE = "subagent-notification";

/** Operator config file, resolved inside `getAgentDir()`. */
export const CONFIG_FILE_NAME = "pi-subagents.json";

/** Subdirectory of `getAgentDir()` that holds agent definition files. */
export const AGENTS_DIR_NAME = "agents";

/** Trusted project override directory, relative to cwd. */
export const PROJECT_AGENTS_DIR = ".pi/agents";

/** Default operator depth ceiling. Finite and required; never unbounded. */
export const DEFAULT_MAX_DEPTH = 1;

/** Process-global registry keys. Jiti isolates modules per session. */
export const LINEAGE_REGISTRY_SYMBOL = Symbol.for(
	"@mcowger/pi-subagents:lineage-registry",
);
export const RUN_REGISTRY_SYMBOL = Symbol.for(
	"@mcowger/pi-subagents:run-registry",
);

/**
 * In-process child lifecycle channels, following the convention shared with
 * `@mcowger/pi-control` so it can route a child's `ask` back to its parent.
 */
export const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";
export const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";
