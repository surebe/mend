# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/surebe/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/surebe/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## What mend does

Models and editors describe file edits in several dialects, and most appliers only
understand one of them. mend is a single command-line tool that takes a patch in any of
the four common dialects — a unified diff, SEARCH/REPLACE blocks, a V4A patch, or a JSON
edit script — recognises which one it has been handed, and applies the edits to the files
in the working directory. The patch lands as a unit: if any edit in it cannot be applied,
nothing is written at all and every failure is reported, so a tree is never left
half-patched.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a file path, or `-` (or absent) for standard input. `--format` names the format
(`auto`, `unified`, `search-replace`, `v4a`, `json`); with `auto` the format is detected from
the patch text. `--check` reports what would change without writing anything. `--strict`
restricts matching to exact lines.

Matching is three-tiered: exact lines, then lines equal up to trailing whitespace, then lines
equal up to leading and trailing whitespace (with re-indentation of the replacement).

Exit codes: 0 when every edit applied, 1 when some edit failed, 2 for usage, missing-patch,
format and parse errors. See SPEC.md for the full contract this tool implements.

`runner.ts` is the make.fun trial runner: it fetches trial checks, runs this tool against
each one in a fresh directory and posts the results back.
