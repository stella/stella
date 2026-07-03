import { describe, expect, test } from "bun:test";

import { buildRunStellaQueryToolDescription } from "@/api/handlers/chat/tools/execute/chat-execution-tool-descriptions";

const WITH_WEB = buildRunStellaQueryToolDescription({
  webResearchAvailable: true,
});
const NO_WEB = buildRunStellaQueryToolDescription({
  webResearchAvailable: false,
});

describe("chat execution tool descriptions", () => {
  test("scopes run-stella-query to internal data and away from web research", () => {
    // Boundary: model should not abuse this tool for legal research or
    // as a thinking scratchpad — those uses caused real hallucinated
    // no-op programs in chat threads.
    for (const description of [WITH_WEB, NO_WEB]) {
      expect(description).toMatch(/internal workspace.+data/iu);
      // The "not a code sandbox / external API" warning holds in both
      // shapes; only the web pointer is conditional.
      expect(description).toMatch(/NOT a general code sandbox/u);
    }
  });

  test("points at the web tools only when they are registered", () => {
    // When web research is off for the turn, the tool description must
    // not name `web_search` / `fetch_url` — the model would be told to
    // call a tool it was never handed (the bug this guards against).
    expect(WITH_WEB).toMatch(/web_search/u);
    expect(WITH_WEB).toMatch(/fetch_url/u);
    expect(NO_WEB).not.toMatch(/web_search/u);
    expect(NO_WEB).not.toMatch(/fetch_url/u);
  });

  test("requires fresh read calls instead of replaying prior data", () => {
    expect(WITH_WEB).toMatch(/describe-stella-api\(\{name\}\)/u);
    expect(WITH_WEB).toContain("`result.items`");
    expect(WITH_WEB).toMatch(/MUST fetch current data/u);
    expect(WITH_WEB).toMatch(/Do not hardcode.+inline arrays/u);
    expect(WITH_WEB).toMatch(/paginate.+until `hasMore` is false/u);
  });
});
