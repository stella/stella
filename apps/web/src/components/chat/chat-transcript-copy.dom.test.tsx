import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { serializeChatSelection } from "./chat-transcript-copy.logic";

GlobalRegistrator.register();
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});
afterAll(() => GlobalRegistrator.unregister());

const fixture = (html: string) => {
  const root = document.createElement("div");
  // safe-html: trusted literal DOM fixtures constructed in this test file.
  root.innerHTML = html;
  document.body.append(root);
  return root;
};

const select = (start: Node, end = start) => {
  const selection = document.getSelection();
  if (selection === null) {
    throw new Error("DOM fixture has no selection");
  }
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.textContent?.length ?? 0);
  selection.addRange(range);
  return selection;
};

describe("transcript copy contains only selected visible text", () => {
  test("filtering hidden nodes preserves selected trailing code newlines", () => {
    const root = fixture(
      '<pre data-chat-message-id="one"><span data-chat-copy-exclude>Copy</span>code\n\n</pre>',
    );
    const message = root.querySelector("pre");
    const start = message?.firstChild?.firstChild;
    const end = message?.lastChild;
    if (
      start === undefined ||
      start === null ||
      end === undefined ||
      end === null
    ) {
      throw new Error("Missing code fixture");
    }
    expect(
      serializeChatSelection({ selection: select(start, end), root })?.text,
    ).toBe("code\n\n");
  });
  test("keeps a partial word selection and escapes markup without copying ancestor attributes", () => {
    const root = fixture(
      '<article style="--font-private:secret"><p data-chat-message-id="one">Selected &lt;word&gt; only</p><p data-chat-message-id="two">Unrelated thread</p></article>',
    );
    const textNode = root.querySelector("p")?.firstChild;
    if (textNode === null || textNode === undefined) {
      throw new Error("Missing message text");
    }
    const selection = select(textNode);
    const range = selection.getRangeAt(0);
    range.setStart(textNode, 9);
    range.setEnd(textNode, 15);
    expect(serializeChatSelection({ selection, root })).toEqual({
      text: "<word>",
      html: "<pre>&lt;word&gt;</pre>",
    });
  });

  test.each([
    "<span hidden>Private hidden payload</span>",
    '<span aria-hidden="true">Private hidden payload</span>',
    '<span style="display:none">Private hidden payload</span>',
    '<span style="visibility:hidden">Private hidden payload</span>',
    '<span style="position:absolute;clip:rect(0px,0px,0px,0px)">Private hidden payload</span>',
    "<span data-chat-copy-exclude>Private hidden payload</span>",
    "<details><summary></summary><div>Private hidden payload</div></details>",
  ])("excludes hidden content by its DOM contract: %s", (hidden) => {
    const root = fixture(
      `<p data-chat-message-id="one">Start ${hidden}end</p>`,
    );
    const message = root.querySelector("p");
    if (
      message?.firstChild === null ||
      message?.firstChild === undefined ||
      message.lastChild === null
    ) {
      throw new Error("Missing message text");
    }
    const selection = select(message.firstChild, message.lastChild);
    expect(serializeChatSelection({ selection, root })).toEqual({
      text: "Start end",
      html: "<pre>Start end</pre>",
    });
  });

  test("preserves code whitespace and selections across multiple messages", () => {
    const root = fixture(
      '<pre data-chat-message-id="one">const text = "&lt;x&gt;";\n  next();</pre><p data-chat-message-id="two">Second message</p>',
    );
    const first = root.querySelector("pre")?.firstChild;
    const last = root.querySelector("p")?.firstChild;
    if (
      first === null ||
      first === undefined ||
      last === null ||
      last === undefined
    ) {
      throw new Error("Missing message text");
    }
    const selection = select(first, last);
    const content = serializeChatSelection({ selection, root });
    expect(content?.text).toBe(selection.toString());
    expect(content?.text).toContain('const text = "<x>";\n  next();');
    expect(content?.text).toContain("Second message");
    expect(content?.html).not.toContain("data-chat-message-id");
    expect(content?.html).toContain("&lt;x&gt;");
  });

  test("copies an open tool code block without its controls or line numbers", () => {
    const root = fixture(
      '<div data-chat-message-id="one"><span>Start</span><details open><summary data-chat-copy-exclude>Tool details</summary><pre><span data-chat-copy-exclude>1</span>  first();\n<span data-chat-copy-exclude>2</span>  next();</pre></details><span>End</span></div>',
    );
    const first = root.querySelector("span")?.firstChild;
    const last = root.querySelector("div > span:last-child")?.firstChild;
    if (
      first === null ||
      first === undefined ||
      last === null ||
      last === undefined
    ) {
      throw new Error("Missing tool text");
    }
    const content = serializeChatSelection({
      selection: select(first, last),
      root,
    });
    expect(content?.text).toContain("  first();\n  next();");
    expect(content?.text).not.toContain("Tool details");
    expect(content?.text).not.toContain("1");
    expect(content?.text).not.toContain("2");
    expect(content?.html).not.toContain("details");
  });

  test("leaves selections that touch another pane to their owner", () => {
    const root = fixture(
      '<p data-chat-message-id="one">Message</p><p>Composer</p>',
    );
    const first = root.firstChild?.firstChild;
    const last = root.lastChild?.firstChild;
    if (
      first === null ||
      first === undefined ||
      last === null ||
      last === undefined
    ) {
      throw new Error("Missing pane text");
    }
    expect(
      serializeChatSelection({ selection: select(first, last), root }),
    ).toBeNull();
  });
});
