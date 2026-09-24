export const EXTENSION_ID = "super-agents-pi";
export const SETTINGS_KEY = "superAgents";
export const EVENT_ENTRY_TYPE = "super-agents-event"; // appendEntry customType
export const RESULT_MESSAGE_TYPE = "super-agents-result"; // sendMessage customType (background results)
export const EVENT_SCHEMA_VERSION = 1;
export const TOOL_AGENT = "agent";
export const TOOL_WAIT = "agent_wait";
export const TOOL_STOP = "agent_stop";
export const TOOL_STATUS = "agent_status";
export const OWN_TOOL_NAMES = [TOOL_AGENT, TOOL_WAIT, TOOL_STOP, TOOL_STATUS] as const;
export const DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const TURN_LIMIT_STEER = "You have reached your turn limit. Stop using tools and give your final answer now.";
export const CHILD_PROMPT_FOOTER = [
	"You are running as a sub-agent on behalf of another agent.",
	"You cannot ask the caller questions; work with the task as given.",
	"Your final message is returned verbatim to the caller as your result, so make it complete and self-contained.",
].join("\n");
export const BACKGROUND_BATCH_MS = 200;
