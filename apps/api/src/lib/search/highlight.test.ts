import { describe, expect, test } from "bun:test";

import {
  escapeAndHighlight,
  HIGHLIGHT_START,
  HIGHLIGHT_STOP,
} from "./highlight";

describe("search result highlighting", () => {
  test("escapes HTML before inserting highlight tags", () => {
    const highlighted = escapeAndHighlight(
      `<script>alert("x")</script> ${HIGHLIGHT_START}Privileged & confidential${HIGHLIGHT_STOP}`,
    );

    expect(highlighted).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; <mark>Privileged &amp; confidential</mark>",
    );
  });

  test("escapes apostrophes and unmatched markers without dropping text", () => {
    expect(escapeAndHighlight(`Client's ${HIGHLIGHT_START}draft`)).toBe(
      "Client&#x27;s <mark>draft",
    );
  });
});
