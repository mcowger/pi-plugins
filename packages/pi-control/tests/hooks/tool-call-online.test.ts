import { describe, expect, it } from "bun:test";
import {
	type ControlsResolvedConfig,
	resolveDecisions,
} from "../../src/config.js";
import { handleToolCall } from "../../src/hooks/tool-call.js";
import { loadLiveEnv } from "../utils/live-env.js";

/**
 * End-to-end live test of the `auto` action: a tool call flows through
 * `handleToolCall` -> `resolveAutoAction` -> the real Decisions API (via the
 * official `@typesafe-ai/sdk`), proving the configured endpoint (with the SDK's
 * `/v1/systemone` path rewritten) and the verdict plumbing work together.
 *
 * OFF BY DEFAULT — same gate as the other live suites:
 *
 *   PICONTROLS_ONLINE_TESTS=1 bun test tests/hooks/tool-call-online.test.ts
 *
 * Requires OPENROUTER_API_KEY (read from `packages/pi-control/.env`, or the
 * environment).
 */

loadLiveEnv();
const LIVE_RUN =
	process.env.PICONTROLS_ONLINE_TESTS === "1" &&
	typeof process.env.OPENROUTER_API_KEY === "string" &&
	process.env.OPENROUTER_API_KEY.length > 0;

const liveConfig: ControlsResolvedConfig = {
	policies: {
		autoPolicy: { defaultAction: "auto", rules: [] },
	},
	locations: { "/tmp": "autoPolicy", "/etc": "autoPolicy" },
	defaultPolicy: null,
	cycleKey: "ctrl+shift+m",
	agentTimeout: null,
	nudgeTimeout: null,
	pathProtection: null,
	decisions: resolveDecisions({ tokenEnv: "OPENROUTER_API_KEY" }),
};

interface StubCtx {
	cwd: string;
	selectTitles: string[];
	ui: {
		notify: () => void;
		confirm: () => Promise<boolean>;
		select: (title: string) => Promise<string>;
		setStatus: () => void;
		theme: {
			fg: (_color: string, text: string) => string;
			bold: (t: string) => string;
		};
	};
	sessionManager: { getSessionId: () => string; getBranch: () => unknown[] };
}

function makeCtx(cwd: string): StubCtx {
	const selectTitles: string[] = [];
	return {
		cwd,
		selectTitles,
		ui: {
			notify: () => {},
			confirm: async () => true,
			// Decline any escalation so a blocked result is observable.
			select: async (title: string) => {
				selectTitles.push(title);
				return "Deny";
			},
			setStatus: () => {},
			theme: { fg: (_color, text) => text, bold: (text) => text },
		},
		sessionManager: { getSessionId: () => "auto-e2e", getBranch: () => [] },
	};
}

function toolEvent(
	toolName: string,
	id: string,
	input: Record<string, unknown>,
) {
	return { type: "tool_call", toolCallId: id, toolName, input };
}

describe.skipIf(!LIVE_RUN)("auto action end to end online", () => {
	it("allows a benign in-project call without prompting", async () => {
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			toolEvent("ls", "auto-e2e-allow", { path: "/tmp" }) as never,
			ctx as never,
			liveConfig,
		);
		expect(result).toBeUndefined();
		expect(ctx.selectTitles.length).toBe(0);
	}, 30000);

	it("escalates a sensitive-system write", async () => {
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			toolEvent("write", "auto-e2e-deny", {
				path: "/etc/hosts",
				content: "127.0.0.1 evil.example",
			}) as never,
			ctx as never,
			liveConfig,
		);
		// ask (declined → block) or deny; never a silent allow.
		const escalated = ctx.selectTitles.length > 0 || result?.block === true;
		console.log(
			`auto e2e write: prompted=${ctx.selectTitles.length > 0} blocked=${result?.block === true}`,
		);
		expect(escalated).toBe(true);
	}, 30000);
});
