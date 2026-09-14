import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Action } from "../config.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const logPath = resolve(getAgentDir(), "extensions", "pi-controls.log");

interface LogEntry {
	ts: string;
	tool: string;
	command?: string;
	cwd: string;
	targets: string[];
	policyName: string | null;
	action: Action | "pass";
	reason?: string;
}

export async function logDecision(entry: LogEntry): Promise<void> {
	try {
		await mkdir(dirname(logPath), { recursive: true });
		await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		// Never let logging break the extension.
	}
}

export async function logStartup(message: string): Promise<void> {
	try {
		await mkdir(dirname(logPath), { recursive: true });
		await appendFile(
			logPath,
			`${JSON.stringify({ ts: new Date().toISOString(), startup: message })}\n`,
			"utf-8",
		);
	} catch {
		// Ignore.
	}
}

export { type LogEntry };
