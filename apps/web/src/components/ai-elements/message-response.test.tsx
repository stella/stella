import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { MessageResponseImpl } from "@/components/ai-elements/message-response";

describe("message response media", () => {
  test("server-rendered image labels name no source and add no preload", () => {
    const source = "![Referenced diagram](https://example.invalid/remote.png)";
    const rendered = renderToStaticMarkup(
      <MessageResponseImpl>{source}</MessageResponseImpl>,
    );

    expect(rendered).toContain("Referenced diagram");
    expect(rendered).not.toContain("example.invalid");
    expect(rendered).not.toMatch(/<(?:img|link)\b/iu);
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
