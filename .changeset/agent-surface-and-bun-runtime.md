---
"@stll/anonymize": minor
"@stll/anonymize-mcp": minor
"@stll/anonymize-cli": minor
---

Add an agent-native CLI/MCP surface and Bun runtime support.

- Structured tool-error envelope `{error:{code,message,hint,retryable}}` across the
  MCP, a distinct CLI exit code per code, budgeted `initialize` instructions, and a
  local, offline `send_feedback` tool / `anonymize feedback` command that sanitizes
  the text and returns a prefilled GitHub issue URL the human submits (no network
  call). anonymize has no destructive tools, so there is no confirm gate.
- Run the native pipeline under Bun via the `@stll/anonymize-wasm` binding, exposed
  through `@stll/anonymize/native-runtime` (`preloadNativeBinding`): the NAPI addon
  calls `uv_get_osfhandle`, which Bun does not implement, so under Bun the wasm
  binding is installed as the loader backend. A no-op on Node.
