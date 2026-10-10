import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { MessageResponseImpl } from "@/components/ai-elements/message-response";
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

test("settled editable responses keep document offsets across blocks and streaming responses have no anchors", () => {
  const source = "First paragraph\n\n## Second heading";
  const settled = renderToStaticMarkup(
    <MessageResponseImpl sourceOffsets>{source}</MessageResponseImpl>,
  );
  expect(settled).toContain('data-src-start="0"');
  expect(settled).toContain(`data-src-start="${source.indexOf("Second")}"`);
  const streaming = renderToStaticMarkup(
    <MessageResponseImpl>{source}</MessageResponseImpl>,
  );
  expect(streaming).not.toContain("data-src-start");
});
