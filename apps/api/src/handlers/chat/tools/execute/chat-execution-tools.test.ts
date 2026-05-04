import { describe, expect, test } from "bun:test";

import { EXECUTE_TYPESCRIPT_TOOL_DESCRIPTION } from "@/api/handlers/chat/tools/execute/chat-execution-tool-descriptions";

describe("chat execution tool descriptions", () => {
  test("requires fresh stella calls instead of replaying prior data", () => {
    expect(EXECUTE_TYPESCRIPT_TOOL_DESCRIPTION).toContain(
      "MUST fetch current data by calling",
    );
    expect(EXECUTE_TYPESCRIPT_TOOL_DESCRIPTION).toContain("stella.");
    expect(EXECUTE_TYPESCRIPT_TOOL_DESCRIPTION).toContain(
      "Do not hardcode, reconstruct, or paste prior results",
    );
    expect(EXECUTE_TYPESCRIPT_TOOL_DESCRIPTION).toContain(
      "const entities = [...]",
    );
    expect(EXECUTE_TYPESCRIPT_TOOL_DESCRIPTION).toContain(
      "prior chat context, visible UI state, examples, and earlier tool outputs are not exhaustive or fresh",
    );
    expect(EXECUTE_TYPESCRIPT_TOOL_DESCRIPTION).toContain(
      "paginate until `hasMore` is false",
    );
  });
});
