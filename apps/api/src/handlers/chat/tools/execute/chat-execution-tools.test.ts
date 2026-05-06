import { describe, expect, test } from "bun:test";

import { RUN_STELLA_QUERY_TOOL_DESCRIPTION } from "@/api/handlers/chat/tools/execute/chat-execution-tool-descriptions";

describe("chat execution tool descriptions", () => {
  test("requires fresh read calls instead of replaying prior data", () => {
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain(
      "For Stella data reads",
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain(
      "call `describe-stella-api({name})` only when you need",
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain(
      "compact function catalog is in the system prompt",
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain("`result.items`");
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain(
      "MUST fetch current data by calling",
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain("read.");
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain(
      "Do not hardcode, reconstruct, or paste prior results",
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain(
      "const entities = [...]",
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain(
      "prior chat context, visible UI state, examples, and earlier tool outputs are not exhaustive or fresh",
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain(
      "paginate until `hasMore` is false",
    );
  });
});
