import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { messageComponents } from "@/components/ai-elements/message-response-components";

describe("message response media", () => {
  test("renders image labels without loading their source", () => {
    const rendered = renderToStaticMarkup(
      messageComponents.img({
        alt: "Referenced diagram",
        src: "https://example.invalid/remote.png",
      }),
    );

    expect(rendered).toContain("Referenced diagram");
    expect(rendered).not.toContain("example.invalid");
  });
});
