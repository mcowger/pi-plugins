import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	buildAgentStatusParams,
	buildAgentStopParams,
	buildAgentToolDescription,
	buildAgentToolParams,
	buildAgentWaitParams,
} from "../src/tool-defs.ts";
import type { AgentDefinition } from "../src/types.ts";

interface SchemaNode {
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	required?: string[];
	minItems?: number;
	maxItems?: number;
	minimum?: number;
	maximum?: number;
	enum?: string[];
}

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		slug: "scout",
		displayName: "Scout",
		description: "Explores code",
		body: "You are a scout.",
		tools: ["read"],
		excludeTools: [],
		extensions: "none",
		excludeExtensions: [],
		skills: "none",
		contextFiles: false,
		systemPromptMode: "append",
		model: undefined,
		thinking: undefined,
		allowModelOverride: false,
		maxTurns: undefined,
		source: "user",
		filePath: "/agents/scout.md",
		...overrides,
	};
}

describe("buildAgentToolParams", () => {
	it("enum contains agent slugs", () => {
		const agents = [makeAgent({ slug: "scout" }), makeAgent({ slug: "writer" })];
		const schema = buildAgentToolParams(agents, DEFAULT_CONFIG) as unknown as SchemaNode;
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		const agentSchema = schema.properties!.tasks.items!.properties!.agent;
		expect(agentSchema.enum).toEqual(["scout", "writer"]);
	});

	it("omits model/thinking when no agent allows override", () => {
		const agents = [makeAgent({ allowModelOverride: false })];
		const schema = buildAgentToolParams(agents, DEFAULT_CONFIG) as unknown as SchemaNode;
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		const taskProps = schema.properties!.tasks.items!.properties!;
		expect(taskProps.model).toBeUndefined();
		expect(taskProps.thinking).toBeUndefined();
	});

	it("includes model/thinking when at least one agent allows override", () => {
		const agents = [
			makeAgent({ slug: "a", allowModelOverride: false }),
			makeAgent({ slug: "b", allowModelOverride: true }),
		];
		const schema = buildAgentToolParams(agents, DEFAULT_CONFIG) as unknown as SchemaNode;
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		const taskProps = schema.properties!.tasks.items!.properties!;
		expect(taskProps.model).toBeDefined();
		expect(taskProps.thinking).toBeDefined();
	});

	it("uses maxTasksPerCall from config for maxItems", () => {
		const agents = [makeAgent()];
		const schema = buildAgentToolParams(agents, {
			...DEFAULT_CONFIG,
			maxTasksPerCall: 3,
		}) as unknown as SchemaNode;
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		expect(schema.properties!.tasks.maxItems).toBe(3);
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		expect(schema.properties!.tasks.minItems).toBe(1);
	});

	it("falls back to a free-form string agent field when there are no agents", () => {
		const schema = buildAgentToolParams([], DEFAULT_CONFIG) as unknown as SchemaNode;
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		const agentSchema = schema.properties!.tasks.items!.properties!.agent;
		expect(agentSchema.enum).toBeUndefined();
	});
});

describe("buildAgentToolDescription", () => {
	it("lists agents with descriptions, marking overridable agents", () => {
		const agents = [
			makeAgent({ slug: "scout", description: "Explores code", allowModelOverride: false }),
			makeAgent({ slug: "writer", description: "Writes docs", allowModelOverride: true }),
		];
		const description = buildAgentToolDescription(agents);
		expect(description).toContain("- scout: Explores code");
		expect(description).not.toContain("scout: Explores code [overridable]");
		expect(description).toContain("- writer: Writes docs [overridable]");
	});

	it("returns the exact empty-agents text when no agents are configured", () => {
		const description = buildAgentToolDescription([]);
		expect(description).toContain(
			"No sub-agents are configured. Agent definitions live in ~/.pi/agent/agents/*.md or .pi/agents/*.md.",
		);
	});
});

describe("other tool param schemas", () => {
	it("agent_wait: ids optional, timeout_seconds integer 1..3600", () => {
		const schema = buildAgentWaitParams() as unknown as SchemaNode;
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		expect(schema.properties!.ids).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		expect(schema.properties!.timeout_seconds.minimum).toBe(1);
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		expect(schema.properties!.timeout_seconds.maximum).toBe(3600);
	});

	it("agent_stop: ids required with minItems 1", () => {
		const schema = buildAgentStopParams() as unknown as SchemaNode;
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		expect(schema.properties!.ids.minItems).toBe(1);
		expect(schema.required).toContain("ids");
	});

	it("agent_status: empty object schema", () => {
		const schema = buildAgentStatusParams() as unknown as SchemaNode;
		expect(Object.keys(schema.properties ?? {})).toEqual([]);
	});
});
