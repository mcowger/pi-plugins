/**
 * Own status enum and terminal-state rules.
 *
 * The vocabulary matches `@tintinweb/pi-subagents` so the wire shape is
 * identical: `steered` is the soft turn-limit wrap-up, `aborted` the hard one.
 */

export type SubagentStatus =
	| "queued"
	| "running"
	| "background"
	| "completed"
	| "steered"
	| "aborted"
	| "stopped"
	| "error";

export const TERMINAL_STATUSES: readonly SubagentStatus[] = [
	"completed",
	"steered",
	"aborted",
	"stopped",
	"error",
];

export function isTerminalStatus(status: SubagentStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

export function isNonTerminalStatus(status: SubagentStatus): boolean {
	return !isTerminalStatus(status);
}
