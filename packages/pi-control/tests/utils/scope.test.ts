import { describe, expect, it } from "bun:test";
import {
	classifyScope,
	localScopeFromTargets,
	resolveScope,
	scopeFromTargets,
} from "../../src/utils/scope.js";

const HOME = "/home/me";
const CWD = "/home/me/proj";

describe("classifyScope", () => {
	it("places the cwd and paths beneath it within", () => {
		expect(classifyScope(CWD, CWD, HOME)).toBe("within");
		expect(classifyScope(`${CWD}/src/a.ts`, CWD, HOME)).toBe("within");
	});

	it("separates temp space from other outside paths", () => {
		expect(classifyScope("/tmp/scratch", CWD, HOME)).toBe("temporary");
		expect(classifyScope("/home/me/other", CWD, HOME)).toBe("outside");
		expect(classifyScope("/home/me/proj-old", CWD, HOME)).toBe("outside");
	});

	it("flags system locations and credential stores", () => {
		expect(classifyScope("/etc/hosts", CWD, HOME)).toBe("sensitive_system");
		expect(classifyScope("/home/me/.ssh/config", CWD, HOME)).toBe(
			"sensitive_system",
		);
		expect(classifyScope(`${CWD}/.env`, CWD, HOME)).toBe("sensitive_system");
		expect(classifyScope(`${CWD}/certs/server.pem`, CWD, HOME)).toBe(
			"sensitive_system",
		);
	});
});

describe("scopeFromTargets", () => {
	it("returns the riskiest label", () => {
		expect(
			scopeFromTargets([`${CWD}/a`, "/tmp/b", "/home/me/c"], CWD, HOME),
		).toBe("outside");
		expect(scopeFromTargets([`${CWD}/a`, "/etc/passwd"], CWD, HOME)).toBe(
			"sensitive_system",
		);
	});

	it("ignores device sinks", () => {
		expect(scopeFromTargets(["/dev/null"], CWD, HOME)).toBeUndefined();
		expect(scopeFromTargets([`${CWD}/a`, "/dev/stderr"], CWD, HOME)).toBe(
			"within",
		);
	});
});

describe("localScopeFromTargets", () => {
	it("reports none when no local path remains", () => {
		expect(localScopeFromTargets([], CWD, HOME)).toEqual({ kind: "none" });
		expect(localScopeFromTargets(["/dev/null"], CWD, HOME)).toEqual({
			kind: "none",
		});
	});
});

describe("resolveScope", () => {
	it("prefers resolved paths over the model", () => {
		expect(resolveScope("outside", { kind: "paths", scope: "within" })).toEqual(
			{ scope: "within", source: "deterministic" },
		);
	});

	it("collapses unknown only when the call names no paths", () => {
		expect(resolveScope("unknown", { kind: "none" })).toEqual({
			scope: "not_applicable",
			source: "fallback",
		});
		expect(resolveScope("remote", { kind: "none" })).toEqual({
			scope: "remote",
			source: "model",
		});
		expect(resolveScope("unknown", undefined)).toEqual({
			scope: "unknown",
			source: "model",
		});
	});
});
