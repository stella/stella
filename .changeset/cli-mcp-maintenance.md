---
"@stll/cli": minor
---

Login persists the default server; `--scopes` takes resource scopes only and the identity set (incl. `offline_access`) is always requested; `whoami` shows the account; `--server` is accepted by every command; the registry drift notice no longer fires for feature-gated tools and names the tools it does report. Removed the no-op `--keychain` flag, renamed `upload --workspace` to `--matter-id`, moved `search read` to `document content`, and `invoke_capability`'s `validateOnly` argument is now `validate_only` (the `--validate-only` flag is unchanged).
