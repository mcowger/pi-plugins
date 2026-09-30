import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveAuto } from "../../src/config.js";
import {
	annotateTargets,
	AUTO_SCOPE_NOTE,
	buildAutoState,
	buildConversation,
	clearPromptStore,
	getUserPrompt,
	normalizeToolInput,
	rememberUserPrompt,
	truncateText,
} from "../../src/utils/auto-state.js";

describe("normalizeToolInput", () => {
	it("keeps the whole bash command and flags truncation", () => {
		expect(normalizeToolInput("bash", { command: "git status" }, 100)).toEqual({
			command: "git status",
			command_truncated: false,
		});
		const truncated = normalizeToolInput(
			"bash",
			{ command: "x".repeat(100) },
			10,
		);
		expect(truncated.command).toBe("x".repeat(10));
		expect(truncated.command_truncated).toBe(true);
	});

	it("reduces read, ls, and grep/find to the relevant fields", () => {
		expect(
			normalizeToolInput(
				"read",
				{ path: "/a/b.ts", offset: 5, limit: 10 },
				100,
			),
		).toEqual({ path: "/a/b.ts", offset: 5, limit: 10 });
		expect(normalizeToolInput("ls", { path: "/tmp", limit: 3 }, 100)).toEqual({
			path: "/tmp",
			limit: 3,
		});
		expect(
			normalizeToolInput(
				"grep",
				{ pattern: "foo", path: "/a", glob: "*.ts", limit: 20 },
				100,
			),
		).toEqual({ path: "/a", pattern: "foo", glob: "*.ts", limit: 20 });
	});

	it("summarizes writes as size plus a head/tail preview", () => {
		const value = normalizeToolInput(
			"write",
			{ path: "/a/b.ts", content: "0123456789abcdefghij" },
			10,
		);
		expect(value.path).toBe("/a/b.ts");
		expect(value.content_bytes).toBe(20);
		expect(value.content_preview).toBe("01\n…\nij");
		expect(value.content_truncated).toBe(true);
	});

	it("sends edits as changed regions, not whole files", () => {
		const value = normalizeToolInput(
			"edit",
			{
				path: "/a/b.ts",
				edits: [{ oldText: "aaaa", newText: "bbbb" }],
			},
			2,
		);
		expect(value.path).toBe("/a/b.ts");
		expect(value.edits).toEqual([{ old: "aa", new: "bb", truncated: true }]);
	});

	it("truncates custom/MCP string fields and marks it", () => {
		const value = normalizeToolInput(
			"my_tool",
			{ text: "x".repeat(20), count: 5 },
			10,
		);
		expect(value.text).toBe("x".repeat(10));
		expect(value.count).toBe(5);
		expect(value._truncated).toBe(true);
	});

	it("caps deeply nested custom tool input", () => {
		const value = normalizeToolInput(
			"my_tool",
			{ files: [{ content: "x".repeat(100) }] },
			10,
		);
		expect(value).toEqual({
			files: [{ content: "x".repeat(10) }],
			_truncated: true,
		});
	});

	it("caps the number of array entries in a custom input", () => {
		const many = Array.from({ length: 200 }, (_, i) => `s${i}`);
		const value = normalizeToolInput("my_tool", { many }, 50);
		expect((value.many as unknown[]).length).toBeLessThanOrEqual(64);
		expect(value._truncated).toBe(true);
	});
});

describe("truncateText", () => {
	it("truncates on a UTF-8 boundary without exceeding the cap", () => {
		const result = truncateText("ééé", 3);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(3);
		expect(result.text).toBe("é");
		expect(result.truncated).toBe(true);
	});

	it("leaves short text alone and truncates long text", () => {
		expect(truncateText("abc", 10)).toEqual({ text: "abc", truncated: false });
		expect(truncateText("abcdef", 3)).toEqual({
			text: "abc",
			truncated: true,
		});
	});
});

describe("buildConversation", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "hello" } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "hi there" },
				],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "long output\n  second   line" }],
			},
		},
		{ type: "compaction", summary: "earlier stuff" },
	];

	function manager() {
		return { getBranch: () => entries } as any;
	}

	it("maps roles, extracts text, and summarizes tool results", () => {
		expect(buildConversation(manager(), 6, 8192)).toEqual([
			{ role: "user", text: "hello" },
			{ role: "assistant", text: "hi there" },
			{ role: "tool", tool: "bash", summary: "long output second line" },
			{ role: "assistant", text: "[summary] earlier stuff" },
		]);
	});

	it("keeps only the newest turns", () => {
		expect(buildConversation(manager(), 2, 8192)).toEqual([
			{ role: "tool", tool: "bash", summary: "long output second line" },
			{ role: "assistant", text: "[summary] earlier stuff" },
		]);
	});

	it("bounds the newest entry when it alone exceeds the byte budget", () => {
		const kept = buildConversation(manager(), 6, 20);
		expect(kept).toEqual([{ role: "assistant", text: "[summary] earlier st" }]);
	});

	it("truncates a single oversized message", () => {
		const huge = {
			getBranch: () => [
				{
					type: "message",
					message: { role: "user", content: "x".repeat(100) },
				},
			],
		};
		const kept = buildConversation(huge as any, 6, 10);
		expect(kept).toEqual([{ role: "user", text: "x".repeat(10) }]);
	});

	it("returns empty for a missing or broken session manager", () => {
		expect(buildConversation(undefined, 6, 8192)).toEqual([]);
		expect(
			buildConversation(
				{
					getBranch: () => {
						throw new Error("no branch");
					},
				} as any,
				6,
				8192,
			),
		).toEqual([]);
	});
});

describe("user prompt store", () => {
	beforeEach(() => clearPromptStore());
	afterEach(() => clearPromptStore());

	it("remembers per session and clears", () => {
		rememberUserPrompt("s1", "do the thing");
		expect(getUserPrompt("s1")).toBe("do the thing");
		expect(getUserPrompt("s2")).toBeUndefined();
		clearPromptStore();
		expect(getUserPrompt("s1")).toBeUndefined();
	});
});

describe("annotateTargets", () => {
	it("labels each target relative to the cwd and drops device sinks", () => {
		expect(
			annotateTargets(
				["/nonexistent-root/proj/src", "/etc/hosts", "/dev/null", "/tmp/x"],
				"/nonexistent-root/proj",
			),
		).toEqual([
			{ path: "/nonexistent-root/proj/src", scope: "within" },
			{ path: "/etc/hosts", scope: "sensitive_system" },
			{ path: "/tmp/x", scope: "temporary" },
		]);
	});
});

describe("buildAutoState", () => {
	beforeEach(() => clearPromptStore());
	afterEach(() => clearPromptStore());

	it("includes tool metadata, the prompt, and the conversation", () => {
		rememberUserPrompt("s1", "please deploy");
		const state = buildAutoState({
			toolName: "bash",
			input: { command: "ls" },
			cwd: "/home/user/proj",
			targets: ["/home/user/proj"],
			sessionId: "s1",
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "user", content: "hi" } },
				],
			} as any,
			toolInfo: {
				name: "bash",
				description: "Run a shell command",
				parameters: { type: "object" },
			} as any,
			auto: resolveAuto({}),
		});
		expect(state.tool).toBe("bash");
		expect(state.input).toEqual({ command: "ls", command_truncated: false });
		expect(state.cwd).toBe("/home/user/proj");
		expect(state.targets).toEqual([
			{ path: "/home/user/proj", scope: "within" },
		]);
		expect(state.tool_description).toBe("Run a shell command");
		expect(state.tool_schema).toEqual({ type: "object" });
		expect(state.user_prompt).toBe("please deploy");
		expect(state.conversation).toEqual([{ role: "user", text: "hi" }]);
		expect(state.scope_note).toBe(AUTO_SCOPE_NOTE);
	});

	it("omits tool metadata and the prompt when unavailable", () => {
		const state = buildAutoState({
			toolName: "my_tool",
			input: { foo: "bar" },
			cwd: "/tmp",
			targets: ["/tmp"],
			sessionId: "missing",
			auto: resolveAuto({}),
		});
		expect(state.tool_description).toBeUndefined();
		expect(state.tool_schema).toBeUndefined();
		expect(state.user_prompt).toBeUndefined();
		expect(state.conversation).toEqual([]);
	});
});
