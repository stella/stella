import { DEFAULT_SANDBOX_LIMITS } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import { LIMITS } from "@/api/lib/limits";

export const DESCRIBE_STELLA_API_TOOL_DESCRIPTION =
  "Describe the readonly stella API available inside " +
  "`run-stella-query`. No input → list `read.*` functions. " +
  "`{name}` → fetch one function's input/output schema and " +
  "TypeScript signature. Every stella data-read result " +
  "stores records in `result.items`; paginated lists also " +
  "include `result.hasMore` and `result.nextOffset`.";

export const RUN_STELLA_QUERY_TOOL_DESCRIPTION =
  "SCOPE: stella's internal workspace/organization data only " +
  "(matters, entities, contacts, etc. via `read.*`). NOT a " +
  "general code sandbox, scratchpad, or way to call external " +
  "APIs — for legal research, public-web facts, or current " +
  "events use `web_search`/`fetch_url` instead, and never " +
  "submit a no-op program just to 'think out loud'. " +
  "Call with TypeScript that uses `read.<functionName>(input)`; " +
  "read returned records from `result.items`. The compact " +
  "function catalog is in the system prompt; call " +
  "`describe-stella-api({name})` only when you need a full " +
  "schema. The program runs inside a sandboxed QuickJS runtime " +
  "as the body of an async function: write top-level statements " +
  "and `return` the value you want back. The program MUST fetch " +
  "current data via `read.<functionName>(input)` this execution. " +
  "Do not hardcode, reconstruct, or paste prior results into " +
  "inline arrays — prior context is not fresh. Use prior refs " +
  "only as inputs to fresh `read.*` calls. For counts/totals/" +
  "exhaustive lists, paginate `result.items` until `hasMore` is " +
  "false. Only side-effect is `read.*`. `console.log` is a no-op; " +
  "no `fetch`, `process`, `require`, filesystem, or network access. " +
  `Limits: code ${LIMITS.chatRunCodeMaxLength.toLocaleString()} chars, ` +
  `${DEFAULT_SANDBOX_LIMITS.maxDurationMs.toLocaleString()}ms, ` +
  `${DEFAULT_SANDBOX_LIMITS.maxHostCalls.toLocaleString()} host calls, ` +
  `${(DEFAULT_SANDBOX_LIMITS.maxReturnBytes / 1024).toLocaleString()} KiB returned.`;
