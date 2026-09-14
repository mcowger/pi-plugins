# Issue #5 — Interpreter Source Analysis Plan

## Goal

Prevent Bash policy evaluation from missing filesystem effects hidden inside
Python, JavaScript, or TypeScript source supplied through heredocs, standard
input, inline evaluation flags, or shell wrappers.

The implementation will use `@vscode/tree-sitter-wasm` for Bash, Python,
JavaScript, and TypeScript. It will remain a static policy-analysis layer; no
execution sandbox or process wrapper will be introduced.

## Current status

The Tree-sitter foundation and interpreter-analysis implementation are present
on branch `fix/issue-5-interpreter-analysis`. The confirmed review findings
have been remediated with unit and policy-integration regressions. Changes
remain uncommitted; complete a final whole-diff review before committing or
shipping. No execution sandbox is part of this plan.

The latest local validation reports:

- `bun test`: 165 tests passed.
- `bunx tsc --noEmit`: passed.
- `git diff --check`: passed.
- `bun run check`: passed with the existing Biome schema notice because the
  repository references schema `2.5.0` while the installed CLI is `2.5.1`.
- A fresh consumer installed from `bun pm pack` successfully initialized the
  packaged Tree-sitter WASM runtime and parsed Python source.

See `STATUS.md` for the detailed implementation summary, confirmed findings,
and remaining work.

## Progress

- [x] Create the implementation branch.
- [x] Add the shared Tree-sitter WASM runtime loader.
- [x] Replace `bash-parser` with the Tree-sitter Bash grammar.
- [x] Preserve existing command, path-argument, pipeline, and redirect tests.
- [x] Extract structured arguments, heredocs, and here-strings.
- [x] Add initial Python, Node, Bun, `env`, and shell-wrapper source extraction.
- [x] Add the shared source-capability model and language analyzers.
- [x] Integrate findings and unresolved effects with policy enforcement.
- [x] Add literal/dynamic path, wrapper, path-protection, and read-only tests.
- [x] Document configuration, behavior, and static-analysis limitations.
- [x] Remediate the review findings and add focused unit and policy regressions.
- [x] Rerun validation and the packed-package WASM smoke test.
- [ ] Complete a final whole-diff review and decide whether to commit.

## Remediated review findings

### Interpreter invocation argument ordering and side effects

`src/utils/interpreter-source.ts` previously found heredoc/inline source
before fully validating the invocation's other arguments. This allowed forms
such as the following to be treated as fully understood despite executing an
unanalyzed script, module, preload, or shell script:

```bash
python3 ./unknown.py <<'PY'
print(1)
PY
python3 -m attacker <<'PY'
print(1)
PY
node ./unknown.js -e 'console.log(1)'
node --require ./attacker.js -e 'console.log(1)'
bash ./unknown.sh -c 'echo ok'
```

Extraction now scans execution-mode arguments in order and marks conflicting
script operands, module execution, preloads/imports/loaders, unsupported
options, dynamic arguments, and trailing Node/Bun runtime flags as unresolved.
It also treats `env -C`/`--chdir` as unresolved so relative source paths are
not evaluated against the wrong working directory. Unit tests cover Python,
Node, and shell conflicts; policy integration verifies that an otherwise
benign heredoc prompts rather than executing silently.

### Python `Path.open` write classification

`Path("/locked").open("w")` was previously observed as a `read` of the
relative path `"w"`, with no unresolved effect. `Path.open` is now handled
before built-in `open`: its receiver is the target path, and modes containing
`w`, `a`, `x`, or `+` are write/create/truncate capabilities. Analyzer and
policy-integration regressions cover this behavior.

### Follow-up coverage

Literal `os.path.join(...)` and default-imported JavaScript `path.join(...)`
now participate in bounded constant propagation. Tests verify that composed
literal paths are evaluated through Python `open` and Node filesystem writes.

## Security posture

- Literal filesystem targets discovered in embedded source are normalized and
  evaluated through the existing location and multi-target policy machinery.
- Dynamic paths, parse errors, unsupported source forms, unknown calls, dynamic
  imports, subprocess execution, and dynamic code evaluation are unresolved
  effects.
- Unresolved effects conservatively require interactive approval and fail
  closed when approval is unavailable.
- Silent execution is preserved only when embedded source is classified as
  read-only and otherwise fully understood.
- Tree-sitter error recovery is not considered successful analysis: `ERROR` or
  missing nodes make the relevant source unresolved.
- This feature is intentionally documented as conservative static analysis, not
  an execution-level security boundary.

## Phase 1 — Tree-sitter Bash foundation

1. Add `@vscode/tree-sitter-wasm` as a runtime dependency.
2. Replace `bash-parser` initialization with a lazily initialized Tree-sitter
   runtime and Bash grammar.
3. Preserve existing behavior for:
   - pipeline and logical-expression stages;
   - redirect targets;
   - path-like arguments;
   - numeric file-descriptor redirects;
   - command reconstruction used by Bash rule matching.
4. Extend each command stage with structured static arguments and embedded
   standard-input source, including heredocs and here-strings.
5. Mark parse failures, expansions, and unsupported command shapes as
   incomplete rather than silently treating them as understood.
6. Retain a minimal tokenizer fallback for ordinary commands, but never use it
   to fail open for an interpreter-shaped command.
7. Remove `bash-parser` after parity and regression tests pass.

## Phase 2 — Interpreter source extraction

1. Detect Python, Node, and Bun executables by basename, including common
   version-suffixed Python names.
2. Unwrap `env` options and environment assignments.
3. Extract source from:
   - Python `-c` and `-` plus heredoc/here-string/stdin;
   - Node `-e`, `--eval`, `-p`, `--print`, and stdin;
   - Bun `-e`, `--eval`, and supported stdin forms.
4. Recursively parse static `bash -c` and `sh -c` payloads.
5. Bound source size, AST node count, and wrapper recursion depth. Exceeding a
   bound yields an unresolved effect.
6. Treat dynamic wrapper arguments, encoded/generated source, and unanalyzed
   script files as unresolved.

## Phase 3 — Shared capability model

Introduce a language-neutral result model:

```ts
interface SourceFinding {
	capability: "read" | "write" | "execute";
	path: string | null;
	evidence: string;
}

interface SourceAnalysis {
	findings: SourceFinding[];
	unresolvedEffects: string[];
	parseErrors: string[];
}
```

A `null` path means the capability is known but its target is dynamic.

Add bounded constant propagation for:

- string literals and constant aliases;
- literal concatenation and templates;
- Python `Path`, `/` path composition, and `os.path.join`;
- JavaScript/TypeScript `path.join` and `path.resolve`;
- an unambiguous current working directory value.

Unknown values remain dynamic; the analyzer must not guess.

## Phase 4 — Python analysis

Recognize imports and aliases for common filesystem operations, initially:

- `open` modes containing `w`, `a`, `x`, or `+`;
- `pathlib.Path` reads and mutations;
- common `os` and `shutil` reads and mutations;
- rename/copy operations with multiple targets.

Classify `subprocess`, `os.system`, `exec`, `eval`, dynamic imports, unknown
third-party imports, and unknown calls as unresolved execution/effects.

Maintain a small explicit allowlist of pure and read-only calls. Absence from a
write-function list is not proof that source is read-only.

## Phase 5 — JavaScript and TypeScript analysis

Recognize ESM, CommonJS, destructured, and aliased forms for:

- Node `fs` and `fs/promises` reads and mutations;
- writable streams and file handles;
- `Bun.write` and writable Bun file APIs;
- common Deno filesystem APIs where they share the same AST model;
- rename/copy operations with multiple targets.

Classify `child_process`, `eval`, `Function`, dynamic imports, unknown module
loads, and unknown calls as unresolved execution/effects.

Use the JavaScript grammar for Node source and the TypeScript grammar for Bun
source when TypeScript syntax is present or accepted.

## Phase 6 — Policy integration

1. Analyze each Bash stage after shell parsing.
2. Add discovered literal targets to the stage's existing target set.
3. Normalize targets and resolve policies exactly as direct Bash paths are
   resolved today.
4. Apply path-protection patterns to analyzed targets instead of relying only
   on whitespace tokenization.
5. Combine unresolved analysis with policy actions as an independent `ask`
   decision; a normal Bash `allow` rule cannot override uncertainty.
6. In noninteractive modes, unresolved analysis fails closed.
7. In `inform` mode, report `would-ask` without blocking.
8. Include analysis evidence and unresolved reasons in JSONL decision logs and
   user-facing prompts.

Proposed configuration:

```jsonc
{
	"interpreterAnalysis": {
		"enabled": true,
		"unknownAction": "ask",
		"maxSourceBytes": 262144,
		"maxDepth": 4
	}
}
```

`unknownAction` may be `ask` or `deny`, but not `allow`. The existing controls
mode remains the explicit way to disable enforcement.

## Phase 7 — Tests and documentation

### Shell parsing

- Existing simple commands, redirects, pipelines, and logical expressions.
- Heredocs, quoted heredoc delimiters, here-strings, and stdin pipelines.
- Wrapper command arguments and shell expansions.
- Parser errors and resource limits.

### Python

- Literal and dynamic writes via `open` and `Path`.
- Imported and aliased APIs.
- Multiple targets.
- Read-only source remains silent.
- Unknown calls, imports, subprocesses, and parse errors require approval.

### JavaScript/TypeScript

- `node -e`, `node --eval`, and `bun -e`.
- `fs`, `fs/promises`, destructured aliases, and `Bun.write`.
- Literal and dynamic targets.
- Read-only source remains silent.
- Dynamic imports, subprocesses, evaluation, and unknown calls require
  approval.

### Wrappers and integration

- `env python3`.
- Recursive `bash -c` and `sh -c`.
- Mixed allow/deny targets choose the most restrictive action.
- Extracted targets are checked by path protection.
- `inform` mode reports without blocking.
- Headless unresolved analysis denies.

Update `README.md` and `examples/sample.jsonc` with behavior, configuration,
limitations, and examples.

## Delivery order

1. Tree-sitter runtime and Bash parser parity.
2. Structured interpreter-source extraction.
3. Shared capability model and conservative fallback.
4. Python analyzer.
5. JavaScript/TypeScript analyzer.
6. Policy and path-protection integration.
7. Remediate review findings, complete regressions and packed-package
   validation, then perform a final whole-diff review.
