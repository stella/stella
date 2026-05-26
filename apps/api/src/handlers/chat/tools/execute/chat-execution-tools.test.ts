import { describe, expect, test } from "bun:test";

import { RUN_STELLA_QUERY_TOOL_DESCRIPTION } from "@/api/handlers/chat/tools/execute/chat-execution-tool-descriptions";

describe("chat execution tool descriptions", () => {
  test("scopes run-stella-query to internal data and away from web research", () => {
    // Boundary: model should not abuse this tool for legal research or
    // as a thinking scratchpad — those uses caused real hallucinated
    // no-op programs in chat threads.
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toMatch(
      /internal workspace.+data/iu,
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toMatch(/web_search/u);
  });

  test("requires fresh read calls instead of replaying prior data", () => {
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toMatch(
      /describe-stella-api\(\{name\}\)/u,
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toContain("`result.items`");
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toMatch(
      /MUST fetch current data/u,
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toMatch(
      /Do not hardcode.+inline arrays/u,
    );
    expect(RUN_STELLA_QUERY_TOOL_DESCRIPTION).toMatch(
      /paginate.+until `hasMore` is false/u,
    );
  });
});
