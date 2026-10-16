import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Editor as TipTapEditor } from "@tiptap/core";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const { Editor, Node } = await import("@tiptap/core");
const { default: Document } = await import("@tiptap/extension-document");
const { default: Paragraph } = await import("@tiptap/extension-paragraph");
const { default: Text } = await import("@tiptap/extension-text");
const { default: Bold } = await import("@tiptap/extension-bold");
const { default: HardBreak } = await import("@tiptap/extension-hard-break");
const { UndoRedo } = await import("@tiptap/extensions");
const { ChatComposerLinks } = await import("@stll/chat/link-editor");
const { createChatComposerDocument } =
  await import("./chat-editor-markdown.logic");
const editors: TipTapEditor[] = [];
const TestAtom = Node.create({
  name: "testAtom",
  group: "inline",
  inline: true,
  atom: true,
  renderHTML: () => ["span", { "data-test-atom": "" }, "reference"],
});

const createEditor = (source: string, linked = true) => {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      HardBreak,
      UndoRedo,
      TestAtom,
      ...(linked ? [ChatComposerLinks] : []),
    ],
    content: createChatComposerDocument(source),
  });
  editors.push(editor);
  return editor;
};

afterEach(() => {
  mock.restore();
  for (const editor of editors) {
    editor.destroy();
  }
  editors.length = 0;
  document.body.replaceChildren();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("composer links are live safe anchors without changing draft or send bytes", () => {
  for (const source of [
    "Compare www.stll.app and https://github.com/stella/stella.",
    "رابط www.stll.app ثم نص عربي",
    "😀 **www.stll.app**\n§ 1.2 and file.pdf",
  ]) {
    const linked = createEditor(source);
    const plain = createEditor(source, false);
    const anchor = linked.view.dom.querySelector("a[data-chat-composer-link]");
    expect(anchor?.getAttribute("href")).toBe("https://www.stll.app/");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(linked.getJSON()).toEqual(plain.getJSON());
    expect(linked.getHTML()).toBe(plain.getHTML());
    expect(linked.getText()).toBe(plain.getText());
    for (const editor of [linked, plain]) {
      editor.commands.insertContentAt(
        editor.state.doc.content.size - 1,
        " https://x.com/stella",
      );
    }
    expect(
      linked.view.dom.querySelector('a[href="https://x.com/stella"]'),
    ).not.toBeNull();
    expect(linked.getHTML()).toBe(plain.getHTML());
    expect(linked.getJSON()).toEqual(plain.getJSON());
    for (const editor of [linked, plain]) {
      editor.commands.undo();
    }
    expect(linked.getHTML()).toBe(plain.getHTML());
    expect(
      linked.view.dom.querySelector('a[href="https://x.com/stella"]'),
    ).toBeNull();
  }
});

test("composer waits for the IME commit before detecting a new link", async () => {
  const editor = createEditor("入力 ");
  editor.view.dom.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  editor.commands.insertContentAt(
    editor.state.doc.content.size - 1,
    "www.stll.app",
  );
  expect(
    editor.view.dom.querySelector("a[data-chat-composer-link]"),
  ).toBeNull();
  const composedDoc = editor.getJSON();
  const composedHtml = editor.getHTML();
  editor.view.dom.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true }),
  );
  await Promise.resolve();
  expect(
    editor.view.dom.querySelector("a[data-chat-composer-link]")?.textContent,
  ).toBe("www.stll.app");
  expect(editor.getJSON()).toEqual(composedDoc);
  expect(editor.getHTML()).toBe(composedHtml);
});

test("link detection spans formatting boundaries but not hard breaks", () => {
  const editor = createEditor("");
  editor.commands.setContent({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "www." },
          { type: "text", text: "stll", marks: [{ type: "bold" }] },
          { type: "text", text: ".app" },
          { type: "hardBreak" },
          { type: "text", text: "www." },
          { type: "hardBreak" },
          { type: "text", text: "stll.app" },
        ],
      },
    ],
  });
  const anchors = Array.from(
    editor.view.dom.querySelectorAll("a[data-chat-composer-link]"),
  );
  const titles = anchors.map((anchor) => anchor.textContent).join("");
  expect(titles).toBe("www.stll.appstll.app");
  expect(editor.getHTML()).toBe(
    "<p>www.<strong>stll</strong>.app<br>www.<br>stll.app</p>",
  );
});

test("composer anchors open immediately with opener isolation", () => {
  const editor = createEditor("www.stll.app");
  const open = spyOn(window, "open").mockReturnValue(null);
  editor.view.dom
    .querySelector("a[data-chat-composer-link]")
    ?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  expect(open).toHaveBeenCalledWith(
    "https://www.stll.app/",
    "_blank",
    "noopener,noreferrer",
  );
});

test("composer links stop at reference atoms without losing adjacent links", () => {
  const editor = createEditor("");
  editor.commands.setContent({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "https://stll.app" },
          { type: "testAtom" },
          { type: "text", text: "github.com" },
        ],
      },
    ],
  });
  const links = Array.from(
    editor.view.dom.querySelectorAll("a[data-chat-composer-link]"),
  );
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "https://stll.app/",
    "https://github.com/",
  ]);
  expect(editor.getText()).toBe("https://stll.appgithub.com");
});
