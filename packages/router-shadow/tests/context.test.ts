import { expect, test } from "bun:test";
import { buildBoundedState } from "../src/context/bounded.js";
import {
	type EntryLike,
	entriesToMessages,
	messagesFromEntry,
} from "../src/context/entries.js";
import { contextView } from "../src/context/view.js";

interface EntriesCase {
	name: string;
	entries: EntryLike[];
	leaf_id: string;
	expected_messages: unknown;
	expected_state: unknown;
}

interface BoundedCase {
	name: string;
	messages: Parameters<typeof buildBoundedState>[0];
	expected_state: unknown;
}

interface ViewCase {
	name: string;
	state: Parameters<typeof contextView>[0];
	expected_text: string;
}

const entriesCases = JSON.parse(
	await Bun.file(
		new URL("./fixtures/entries_to_messages.json", import.meta.url),
	).text(),
) as EntriesCase[];

for (const c of entriesCases) {
	test(`entriesToMessages: ${c.name}`, () => {
		// The fixture branch already ends with the prompt's entry, so passing
		// the last expected message's text as the prompt must not append.
		const lastExpected = c.expected_messages as { text: string }[];
		const prompt = lastExpected[lastExpected.length - 1].text;
		const actual = entriesToMessages(c.entries, prompt, false);
		expect(JSON.parse(JSON.stringify(actual))).toEqual(c.expected_messages);
	});

	test(`buildBoundedState via entries: ${c.name}`, () => {
		const lastExpected = c.expected_messages as { text: string }[];
		const prompt = lastExpected[lastExpected.length - 1].text;
		const messages = entriesToMessages(c.entries, prompt, false);
		expect(JSON.parse(JSON.stringify(buildBoundedState(messages)))).toEqual(
			c.expected_state,
		);
	});
}

const boundedCases = JSON.parse(
	await Bun.file(
		new URL("./fixtures/bounded_state.json", import.meta.url),
	).text(),
) as BoundedCase[];

for (const c of boundedCases) {
	test(`buildBoundedState: ${c.name}`, () => {
		expect(JSON.parse(JSON.stringify(buildBoundedState(c.messages)))).toEqual(
			c.expected_state,
		);
	});
}

const viewCases = JSON.parse(
	await Bun.file(
		new URL("./fixtures/context_view.json", import.meta.url),
	).text(),
) as ViewCase[];

for (const c of viewCases) {
	test(`contextView: ${c.name}`, () => {
		expect(contextView(c.state)).toBe(c.expected_text);
	});
}

test("R6.2: appends the prompt when the branch does not contain it", () => {
	const branch: EntryLike[] = [
		{
			type: "message",
			id: "e1",
			parentId: null,
			message: { role: "user", content: [{ type: "text", text: "old" }] },
		},
	];
	const messages = entriesToMessages(branch, "new request", true);
	expect(messages.length).toBe(2);
	expect(messages[1]).toMatchObject({
		role: "user",
		text: "new request",
		has_image: true,
	});
});

test("R6.2: no append when the last message matches after collapsing", () => {
	const branch: EntryLike[] = [
		{
			type: "message",
			id: "e1",
			parentId: null,
			message: {
				role: "user",
				content: [{ type: "text", text: "Fix  the\nbuild" }],
			},
		},
	];
	const messages = entriesToMessages(branch, "Fix the build", true);
	expect(messages.length).toBe(1);
	expect(messages[0].has_image).toBe(true);
});

test("messagesFromEntry: walks from the turn entry, not the leaf", () => {
	// Entries pi persists during the run (system message, assistant reply)
	// must not leak into the turn's context.
	const branch: EntryLike[] = [
		{
			type: "message",
			id: "sys",
			parentId: null,
			message: { role: "system", content: "" },
		},
		{
			type: "message",
			id: "u1",
			parentId: "sys",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		},
	];
	const messages = messagesFromEntry(branch, "u1", "hello", false);
	expect(messages.map((m) => [m.role, m.text])).toEqual([
		["system", ""],
		["user", "hello"],
	]);
});

test("findPromptEntryId: prefers entries outside the snapshot branch", async () => {
	const { findPromptEntryId } = await import("../src/index.js");
	const branch = [
		{
			type: "message",
			id: "old",
			message: { role: "user", content: [{ type: "text", text: "same" }] },
		},
		{
			type: "message",
			id: "new",
			message: { role: "user", content: [{ type: "text", text: "same" }] },
		},
	];
	expect(findPromptEntryId(branch, "same", new Set(["old"]))).toBe("new");
	expect(findPromptEntryId(branch, "same")).toBe("new");
	expect(findPromptEntryId([branch[0]], "same", new Set(["old"]))).toBe("old");
	expect(findPromptEntryId([branch[0]], "missing")).toBeNull();
});

test("R6.2: empty branch yields only the prompt", () => {
	const messages = entriesToMessages([], "hello", false);
	expect(messages).toEqual([
		{
			role: "user",
			text: "hello",
			tool_calls: null,
			name: null,
			has_image: false,
			api: null,
		},
	]);
});
