import { DEFAULT_SANDBOX_LIMITS } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import { LIMITS } from "@/api/lib/limits";

export const DESCRIBE_STELLA_API_TOOL_DESCRIPTION =
  "Describe the readonly Stella API available inside " +
  "`run-stella-query`. Call with no input to list available " +
  "`read.*` data-read functions. Call with `{name}` to fetch " +
  "one function's input/output JSON Schema and TypeScript " +
  "signature. Use this when you need the catalog before writing " +
  "a Stella query. Every Stella data-read result stores records " +
  "in `result.items`; paginated list results also include " +
  "`result.hasMore` and `result.nextOffset`.";

export const RUN_STELLA_QUERY_TOOL_DESCRIPTION =
  "Run a readonly Stella data query in TypeScript. For Stella " +
  "data reads: call this tool with TypeScript that uses " +
  "`read.<functionName>(input)`, then read returned records from " +
  "`result.items`. The compact function catalog is in the system " +
  "prompt; call `describe-stella-api({name})` only when you need " +
  "a function's full input/output schema. The program runs inside a sandboxed QuickJS " +
  "runtime as the body of an async function: write top-level " +
  "statements and `return` the value you want back. For " +
  "workspace or organization data, the program MUST fetch " +
  "current data by calling `read.<functionName>(input)` " +
  "during this execution. " +
  "Do not hardcode, reconstruct, or paste prior results into " +
  "inline arrays such as `const entities = [...]`; prior " +
  "chat context, visible UI state, examples, and earlier tool " +
  "outputs are not exhaustive or fresh. Use prior refs only " +
  "as inputs to fresh `read.*` calls. For counts, totals, " +
  "or exhaustive lists, read records from `result.items` and " +
  "paginate until `hasMore` is false, " +
  "then answer from the fetched result; if you cannot fetch " +
  "the complete dataset within limits, say that explicitly. " +
  "The only side-effect is `read.<functionName>(input)`. " +
  "`console.log` is a no-op; only the returned value " +
  "comes back. No `fetch`, `process`, `require`, filesystem, " +
  "or network access. Limits: code " +
  `up to ${LIMITS.chatRunCodeMaxLength.toLocaleString()} chars, ` +
  `up to ${DEFAULT_SANDBOX_LIMITS.maxDurationMs.toLocaleString()}ms, ` +
  `up to ${DEFAULT_SANDBOX_LIMITS.maxHostCalls.toLocaleString()} host calls, ` +
  `up to ${(DEFAULT_SANDBOX_LIMITS.maxReturnBytes / 1024).toLocaleString()} KiB returned.`;
