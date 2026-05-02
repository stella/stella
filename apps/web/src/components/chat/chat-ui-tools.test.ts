import { describe, expect, test } from "bun:test";

import { getChatToolTitleKey } from "@/components/chat/chat-ui-tools";

describe("chat tool titles", () => {
  test("maps current cross-matter tools to translation keys", () => {
    expect(getChatToolTitleKey("search-across-matters")).toBe(
      "chat.tool.search-across-matters",
    );
    expect(getChatToolTitleKey("read-content-across-matters")).toBe(
      "chat.tool.read-content-across-matters",
    );
  });

  test("uses the translated unknown fallback for unknown tools", () => {
    expect(getChatToolTitleKey("searchCaseLaw")).toBe("chat.tool.unknown");
  });
});
