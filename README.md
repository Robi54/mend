# mend

One patch tool for every AI edit format: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls — applied to a tree of files, all or nothing.

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/robi54/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/robi54/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

## Run

```sh
node main.ts [PATCH]
```

`PATCH` is read from standard input when absent or `-`. Options: `--format=unified|search-replace|v4a|json|auto`, `--check`, `--strict`.

See [SPEC.md](SPEC.md) for the full specification, and the bounty at https://make.fun/bounty/hidden-spec-cli-01-run-20261122.
