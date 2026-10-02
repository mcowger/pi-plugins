import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import {
	buildTierMap,
	classifyActualSource,
	classifyOrigin,
	isAck,
	mapModelToTier,
} from "../src/origin.js";

test("isAck matches short acknowledgements", () => {
	for (const ack of [
		"ok",
		"OK!",
		"thanks",
		"Thank you.",
		"go ahead",
		"please continue",
		"sounds good",
		"do it",
	]) {
		expect(isAck(ack)).toBe(true);
	}
});

test("isAck rejects substantive prompts", () => {
	// Note: the spec regex is prefix-anchored with no end anchor, so prompts
	// that merely *start* with an ack word still count as acks.
	for (const no of [
		"",
		"   ",
		"please refactor the router",
		"token expired, retry",
		"k9s is down",
		"okey-dokey",
		"x".repeat(41),
	]) {
		expect(isAck(no)).toBe(false);
	}
});

test("classifyOrigin: parentSession means subagent", () => {
	expect(
		classifyOrigin("do the thing", { isSubagentSession: true }).origin,
	).toBe("subagent");
});

test("classifyOrigin: delegated prefixes mean subagent", () => {
	for (const prompt of [
		"Task: You are a delegated subagent. Explore.",
		"You are a delegated subagent for auth.",
		"Message Type: NEW_TASK\nDo X.",
		'<skill name="explore">go',
	]) {
		expect(classifyOrigin(prompt, { isSubagentSession: false }).origin).toBe(
			"subagent",
		);
	}
	expect(
		classifyOrigin('<skill name="explore">go', { isSubagentSession: false })
			.skill_name,
	).toBe("explore");
});

test("classifyOrigin: input source mapping", () => {
	expect(
		classifyOrigin("hi", { isSubagentSession: false, inputSource: "extension" })
			.origin,
	).toBe("extension");
	expect(
		classifyOrigin("hi", {
			isSubagentSession: false,
			inputSource: "interactive",
		}).origin,
	).toBe("human");
	expect(
		classifyOrigin("hi", { isSubagentSession: false, inputSource: "rpc" })
			.origin,
	).toBe("human");
	expect(classifyOrigin("hi", { isSubagentSession: false }).origin).toBe(
		"unknown",
	);
});

test("classifyActualSource follows R5.3", () => {
	expect(classifyActualSource(true, "subagent", false)).toBe("subagent_config");
	expect(classifyActualSource(false, "human", true)).toBe("user_selection");
	expect(classifyActualSource(false, "human", false)).toBe("unknown");
	expect(classifyActualSource(false, "extension", true)).toBe("unknown");
});

const modelsData = JSON.parse(
	await Bun.file(new URL("../models.json", import.meta.url)).text(),
);

test("models.json maps aliases and synonyms to tiers", () => {
	const tierMap = buildTierMap(modelsData);
	expect(mapModelToTier("deepseek-v4.1-flash", tierMap)).toBe("economy");
	expect(mapModelToTier("gpt-6-luna", tierMap)).toBe("standard");
	expect(mapModelToTier("claude-opus-5.5", tierMap)).toBe("high");
	expect(mapModelToTier("gpt-6.1-sol", tierMap)).toBe("premium");
	expect(mapModelToTier("deepseek/deepseek-v4-flash", tierMap)).toBe("economy");
	expect(mapModelToTier("openai/gpt-6-sol", tierMap)).toBe("premium");
	expect(mapModelToTier("something-else", tierMap)).toBeNull();
	expect(mapModelToTier(undefined, tierMap)).toBeNull();
});

test("loadConfig defaults and overrides", () => {
	const defaults = loadConfig({ env: {}, extensionDir: "/ext" });
	expect(defaults.enabled).toBe(true);
	expect(defaults.candidates).toEqual(["jev-all", "jev-k24", "jev-zeroshot"]);
	expect(defaults.jevModel).toBe("jev-1.13");
	expect(defaults.k).toBe(24);
	expect(defaults.bundlePath).toBe("/ext/exemplars.json");
	expect(defaults.modelsPath).toBe("/ext/models.json");
	expect(defaults.sampleRate).toBe(1.0);
	expect(defaults.routeSubagents).toBe(true);
	expect(defaults.footer).toBe(false);

	const overridden = loadConfig({
		settings: {
			routerShadow: undefined,
			candidates: ["jev-zeroshot"],
			footer: true,
			routeSubagents: false,
			k: 8,
		},
		env: {
			ROUTER_SHADOW_ENABLED: "0",
			ROUTER_SHADOW_CANDIDATES: "jev-all",
			PLEXUS_API_BASE: "https://x.example",
			PLEXUS_API_KEY: "k",
		},
		extensionDir: "/ext",
	});
	expect(overridden.enabled).toBe(false);
	expect(overridden.candidates).toEqual(["jev-all"]);
	expect(overridden.footer).toBe(true);
	expect(overridden.routeSubagents).toBe(false);
	expect(overridden.k).toBe(8);
	expect(overridden.apiBase).toBe("https://x.example");
	expect(overridden.apiKey).toBe("k");
});
