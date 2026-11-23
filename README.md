# mend

A patch tool that reads a patch in any of four formats — unified diff, SEARCH/REPLACE blocks,
V4A (*** Begin Patch) and JSON edit scripts — and applies it to the working directory,
reporting exactly what changed.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a file path, or `-` (or absent) for standard input. `--format` names the format
(`auto`, `unified`, `search-replace`, `v4a`, `json`); with `auto` the format is detected from
the patch text. `--check` reports what would change without writing anything. `--strict`
restricts matching to exact lines.

Matching is three-tiered: exact lines, then lines equal up to trailing whitespace, then lines
equal up to leading and trailing whitespace (with re-indentation of the replacement). A patch
is atomic: if any edit fails, nothing is written and every failure is reported.

Exit codes: 0 when every edit applied, 1 when some edit failed, 2 for usage, missing-patch,
format and parse errors. See SPEC.md for the full contract this tool implements.

`runner.ts` is the make.fun trial runner: it fetches trial checks, runs this tool against
each one in a fresh directory and posts the results back.
