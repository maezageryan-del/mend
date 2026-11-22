# mend
[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/maezageryan-del/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/maezageryan-del/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It applies unified diffs (even with wrong
line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON to a
tree of text files, to one written specification — changing every file or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a patch file, or `-` (or absent) to read the patch from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`, or `auto`
  (the default, which detects the format).
- `--check` does everything but write: same output and exit code, no file changed.
- `--strict` matches lines exactly (tier 0 only).

Edits find the lines they name at the first of three matching tiers: exact, then ignoring
trailing whitespace, then ignoring leading and trailing whitespace (re-indenting the new
lines to the file's own indentation). A failed edit changes nothing, and the edits after it
still run, so every failure is reported; when any edit failed, no file is written.

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R old -> new`) and `ok: <n> files`.
Exit 1 prints one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`.
Exit 2 prints a single usage, no-patch, format, or parse error line.

Node 22 and its standard library only; no dependencies, no install step.
