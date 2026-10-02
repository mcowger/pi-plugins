/**
 * `/router-shadow status` aggregation (REQUIREMENTS R13).
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { utcDate } from "./log.js";

export interface CandidateStats {
	n: number;
	errors: number;
	latencies: number[];
	mix: Record<string, number>;
	agree: number;
	agreeN: number;
}

export interface StatusReport {
	date: string;
	routed: number;
	skipped: number;
	records: number;
	candidates: Record<string, CandidateStats>;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(p * sorted.length) - 1),
	);
	return sorted[index];
}

function emptyCandidate(): CandidateStats {
	return { n: 0, errors: 0, latencies: [], mix: {}, agree: 0, agreeN: 0 };
}

/** Stream today's decisions file into aggregate stats. */
export async function collectStatus(
	logDir: string,
	now: number = Date.now(),
): Promise<StatusReport> {
	const date = utcDate(now);
	const report: StatusReport = {
		date,
		routed: 0,
		skipped: 0,
		records: 0,
		candidates: {},
	};
	const path = join(logDir, `decisions-${date}.jsonl`);
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const statsFor = (id: string): CandidateStats =>
		(report.candidates[id] ??= emptyCandidate());
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			report.records++;
			if (typeof record.skipped === "string" && record.skipped) {
				report.skipped++;
				continue;
			}
			report.routed++;
			const actual = (record.actual ?? {}) as Record<string, unknown>;
			const forAgreement =
				record.origin === "human" &&
				actual.source === "user_selection" &&
				typeof actual.tier === "string";
			const candidates = (record.candidates ?? {}) as Record<
				string,
				Record<string, unknown>
			>;
			for (const [id, candidate] of Object.entries(candidates)) {
				const stats = statsFor(id);
				stats.n++;
				if (typeof candidate.error === "string" && candidate.error) {
					stats.errors++;
					continue;
				}
				if (typeof candidate.latency_ms === "number") {
					stats.latencies.push(candidate.latency_ms);
				}
				if (typeof candidate.tier === "string") {
					stats.mix[candidate.tier] = (stats.mix[candidate.tier] ?? 0) + 1;
					if (forAgreement) {
						stats.agreeN++;
						if (candidate.tier === actual.tier) stats.agree++;
					}
				}
			}
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	for (const stats of Object.values(report.candidates)) {
		stats.latencies.sort((a, b) => a - b);
	}
	return report;
}

function formatPercent(numerator: number, denominator: number): string {
	if (denominator === 0) return "n/a";
	return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/** Compact multi-line status text for `ctx.ui.notify`. */
export function formatStatus(report: StatusReport): string {
	const out = [
		`[router-shadow] ${report.date}: ${report.routed} routed, ${report.skipped} skipped`,
	];
	for (const [id, stats] of Object.entries(report.candidates).sort()) {
		const p50 = percentile(stats.latencies, 0.5);
		const p90 = percentile(stats.latencies, 0.9);
		const mix = Object.entries(stats.mix)
			.sort()
			.map(([tier, n]) => `${tier[0]}:${n}`)
			.join(" ");
		out.push(
			`  ${id}: n=${stats.n} err=${stats.errors} p50=${p50.toFixed(0)}ms p90=${p90.toFixed(0)}ms mix[${mix}] agree=${formatPercent(stats.agree, stats.agreeN)}`,
		);
	}
	return out.join("\n");
}
