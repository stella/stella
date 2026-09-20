---
"@stll/cli": minor
---

`stella feedback prepare` now takes a structured report (`--kind`, `--area`, `--title`, `--what-happened`, optional `--expected`, `--steps`, `--evidence`, and `--context.*`) and returns the sanitized report without sending anything. The new `stella feedback submit` files the approved report with the maintainers and prints a receipt (`FB-XXXX-XXXX`); it asks for confirmation, and `--yes` skips the prompt. The prefilled issue URL and `gh` command are gone.
