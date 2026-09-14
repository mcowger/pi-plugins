# Issue #5 — Current Status

**Branch:** `fix/issue-5-interpreter-analysis`

**Status:** The initial implementation and confirmed review remediations are complete. Validation and packed-package testing pass; perform a final whole-diff review before deciding whether to commit or release. Changes are uncommitted.

## Completed

- Added `@vscode/tree-sitter-wasm` as a runtime dependency.
- Replaced the `bash-parser` integration with Tree-sitter Bash parsing.
- Added shared Tree-sitter runtime and grammar loading in `src/utils/tree-sitter.ts`.
- Preserved existing Bash path, redirect, pipeline, logical-expression, and command-pattern behavior.
- Added structured shell arguments, heredoc extraction, and here-string extraction.
- Added interpreter source extraction for:
  - Python `-c` and static heredoc/here-string input;
  - Node `-e`, `--eval`, `-p`, and `--print`;
  - Bun inline evaluation;
  - `env` wrappers;
  - recursive static `bash -c` and `sh -c` wrappers.
- Added initial conservative Python, JavaScript, and TypeScript capability analysis.
- Added literal path extraction and bounded constant propagation for the covered forms.
- Added detection of dynamic paths, unknown calls/imports, subprocess/evaluation behavior, parser errors, and analysis limits.
- Remediated review findings for invocation argument ordering, runtime preload/module flags, `env` working-directory changes, and receiver-aware `Path.open` modes; see **Remediated review findings** below.
- Integrated analyzed targets with location policies and path protection.
- Added configurable `interpreterAnalysis` behavior:
  - enabled by default;
  - unresolved effects default to `ask`;
  - `unknownAction: "deny"` is supported for unattended environments;
  - analysis can be disabled with `interpreterAnalysis: null`.
- Added user-facing and JSONL decision context for unresolved analysis.
- Updated `README.md`, `examples/sample.jsonc`, and `PLAN.md`.
- Removed the obsolete `bash-parser` dependency.

## Validation

The following was rerun after remediation:

- `bun test`: **165 tests passed**.
- `bunx tsc --noEmit`: passed.
- `git diff --check`: passed.
- `bun run check`: passes with the repository's existing Biome schema notice (`2.5.0` schema versus CLI `2.5.1`).
- A fresh consumer installed from `bun pm pack` initialized the packaged
  Tree-sitter WASM runtime and successfully parsed Python source.

## Remediated review findings

### 1. Invocation arguments could conceal unanalyzed execution

`src/utils/interpreter-source.ts` previously accepted heredoc or inline source
before it fully validated other interpreter arguments. The following commands
were previously extracted as benign source with no unresolved effect:

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

These forms can execute an unanalyzed script/module/preload while allowing the
extracted source to appear harmless. Extraction now performs conservative,
runtime-specific argv scanning: conflicting script operands, Python modules,
Node/Bun preloads/imports/loaders, dynamic arguments, unsupported options, and
trailing Node/Bun runtime flags are unresolved. `env -C`/`--chdir` also becomes
unresolved, preventing relative source paths from being assessed against the
wrong CWD. Unit regressions cover each runtime family, and a policy regression
confirms that a conflicting Python invocation prompts rather than running
silently.

### 2. `pathlib.Path.open` could be silently misclassified

The Python analysis was previously run against:

```python
from pathlib import Path
Path("/locked").open("w")
```

It returned a `read` finding for the relative path `"w"` and no unresolved
effect. This is incorrect: the call opens `/locked` for writing/creation.
`Path.open` is now receiver-aware, uses its mode argument to classify `w`,
`a`, `x`, and `+` as writes, and is covered by analyzer and policy integration
regressions.

### 3. Planned literal path composition is now covered

Literal `os.path.join(...)` and default-imported JavaScript `path.join(...)`
now resolve through bounded constant propagation. Regressions verify their
use as Python and Node filesystem targets.

## Remaining work

1. Perform a final whole-diff review, including all untracked source and test
   files, before deciding whether to commit; no commit has been created yet.
2. No execution sandbox or `@anthropic-ai/sandbox-runtime` is included or
   planned.
