import type { CommandStage } from "./bash-ast.js";
import { parseCommand } from "./bash-ast.js";
import { extractInterpreterSources } from "./interpreter-source.js";
import {
	analyzeSource,
	type SourceAnalysis,
	type SourceFinding,
} from "./source-analysis.js";

export interface CommandSourceAnalysis extends SourceAnalysis {
	/** True when this stage or a recursively nested stage invoked an interpreter. */
	interpreterDetected: boolean;
}

export interface CommandSourceAnalysisOptions {
	cwd: string;
	maxDepth?: number;
	maxNodes?: number;
	maxSourceBytes?: number;
}

const DEFAULT_MAX_DEPTH = 4;

function emptyAnalysis(): CommandSourceAnalysis {
	return {
		findings: [],
		unresolvedEffects: [],
		parseErrors: [],
		interpreterDetected: false,
	};
}

function mergeAnalysis(
	target: CommandSourceAnalysis,
	source: Pick<
		SourceAnalysis,
		"findings" | "parseErrors" | "unresolvedEffects"
	>,
): void {
	target.findings.push(...source.findings);
	target.unresolvedEffects.push(...source.unresolvedEffects);
	target.parseErrors.push(...source.parseErrors);
}

function dedupe<T>(values: T[]): T[] {
	return [...new Set(values)];
}

/** Analyze interpreter source attached to one Bash command stage. */
export async function analyzeCommandStageSource(
	stage: CommandStage,
	options: CommandSourceAnalysisOptions,
	depth = 0,
): Promise<CommandSourceAnalysis> {
	const result = emptyAnalysis();
	const extraction = extractInterpreterSources(stage, {
		maxSourceBytes: options.maxSourceBytes,
	});
	if (
		extraction.sources.length === 0 &&
		extraction.unresolvedEffects.length === 0
	) {
		return result;
	}

	result.interpreterDetected = true;
	result.unresolvedEffects.push(...extraction.unresolvedEffects);
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

	for (const embedded of extraction.sources) {
		if (embedded.language === "shell") {
			if (depth >= maxDepth) {
				result.unresolvedEffects.push(
					`Nested shell source exceeds the analysis depth limit of ${maxDepth}`,
				);
				continue;
			}
			const nestedStages = await parseCommand(embedded.source);
			if (nestedStages.length === 0) {
				result.unresolvedEffects.push(
					"Nested shell source produced no command stages",
				);
				continue;
			}
			for (const nestedStage of nestedStages) {
				const nested = await analyzeCommandStageSource(
					nestedStage,
					options,
					depth + 1,
				);
				mergeAnalysis(result, nested);
				result.interpreterDetected ||= nested.interpreterDetected;
				// A shell payload that is not itself an interpreter still has direct
				// paths handled by normal Bash stage extraction. Preserve those paths
				// as read/write-agnostic findings so location policy can evaluate them.
				for (const path of [
					...nestedStage.redirectFiles,
					...nestedStage.pathArgs,
				]) {
					result.findings.push({
						capability: "write",
						path,
						evidence: `Nested shell target in ${embedded.interpreter} -c`,
					});
				}
			}
			continue;
		}

		const analysis = await analyzeSource(embedded.language, embedded.source, {
			cwd: options.cwd,
			maxNodes: options.maxNodes,
		});
		mergeAnalysis(result, analysis);
	}

	result.unresolvedEffects = dedupe(result.unresolvedEffects);
	result.parseErrors = dedupe(result.parseErrors);
	result.findings = result.findings.filter(
		(finding, index, findings) =>
			findings.findIndex(
				(candidate: SourceFinding) =>
					candidate.capability === finding.capability &&
					candidate.path === finding.path &&
					candidate.evidence === finding.evidence,
			) === index,
	);
	return result;
}
