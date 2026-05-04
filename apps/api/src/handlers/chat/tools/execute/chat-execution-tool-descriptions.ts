import { DEFAULT_SANDBOX_LIMITS } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import { LIMITS } from "@/api/lib/limits";

export const DESCRIBE_STELLA_FUNCTION_TOOL_DESCRIPTION =
  "Discover the readonly `stella` API available inside " +
  "`execute-typescript`. Call with no input to list every " +
  "available function name + one-line description. Call " +
  "with `{name}` to fetch one function's full JSON Schema " +
  "(input, output, types). The catalog is NOT pre-loaded in " +
  "the system prompt: call this whenever you need to " +
  "compose a `stella.*` query.";

export const EXECUTE_TYPESCRIPT_TOOL_DESCRIPTION =
  "Escape hatch for arbitrary readonly queries the focused " +
  "tools can't express (cross-matter search, joins, " +
  "aggregations). Runs a TypeScript program inside a " +
  "sandboxed QuickJS runtime; the program is the body of an " +
  "async function: write top-level statements and `return` " +
  "the value you want back. For workspace or organization " +
  "data, the program MUST fetch current data by calling " +
  "`stella.<functionName>(input)` during this execution. " +
  "Do not hardcode, reconstruct, or paste prior results into " +
  "inline arrays such as `const entities = [...]`; prior " +
  "chat context, visible UI state, examples, and earlier tool " +
  "outputs are not exhaustive or fresh. Use prior refs only " +
  "as inputs to fresh `stella.*` calls. For counts, totals, " +
  "or exhaustive lists, paginate until `hasMore` is false, " +
  "then answer from the fetched result; if you cannot fetch " +
  "the complete dataset within limits, say that explicitly. " +
  "The only side-effect is `stella.<functionName>(input)`. " +
  "The function catalog is NOT in the system prompt — call " +
  "`describe-stella-function` (no input) to list available " +
  "functions, then with `{name}` for one function's full " +
  "schema. `console.log` is a no-op; only the returned value " +
  "comes back. No `fetch`, `process`, `require`, filesystem, " +
  "or network access. Limits: code " +
  `up to ${LIMITS.chatRunCodeMaxLength.toLocaleString()} chars, ` +
  `up to ${DEFAULT_SANDBOX_LIMITS.maxDurationMs.toLocaleString()}ms, ` +
  `up to ${DEFAULT_SANDBOX_LIMITS.maxHostCalls.toLocaleString()} host calls, ` +
  `up to ${(DEFAULT_SANDBOX_LIMITS.maxReturnBytes / 1024).toLocaleString()} KiB returned.`;
