import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
// The preview's worker entry is a Vite `?worker&url` import; the draft text
// never reaches the worker.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});

const { act, cleanup, render } = await import("@testing-library/react");
const { Editor } = await import("@tiptap/react");
const { default: Document } = await import("@tiptap/extension-document");
const { default: Paragraph } = await import("@tiptap/extension-paragraph");
const { default: Text } = await import("@tiptap/extension-text");
const { useChatDraftText } = await import("./use-chat-anonymize");

const editors: InstanceType<typeof Editor>[] = [];

afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) {
    editor.destroy();
  }
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const createEditor = (text: string) => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [Document, Paragraph, Text],
    content: `<p>${text}</p>`,
  });
  editors.push(editor);
  return editor;
};

const replaceText = (editor: InstanceType<typeof Editor>, text: string) => {
  act(() => {
    editor.chain().selectAll().insertContent(text).run();
  });
};

const DraftText = ({
  editor,
  enabled,
}: {
  editor: InstanceType<typeof Editor> | null;
  enabled: boolean;
}) => <output>{useChatDraftText(editor, enabled)}</output>;

test("the draft text is the editor's text on the first render and follows each update", () => {
  const editor = createEditor("first draft");
  const view = render(<DraftText editor={editor} enabled />);
  expect(view.container.textContent).toBe("first draft");

  replaceText(editor, "second draft");
  expect(view.container.textContent).toBe("second draft");
});

test("a disabled watcher reads nothing and starts from the live text once enabled", () => {
  const editor = createEditor("first draft");
  const view = render(<DraftText editor={editor} enabled={false} />);
  expect(view.container.textContent).toBe("");

  replaceText(editor, "typed while off");
  expect(view.container.textContent).toBe("");

  view.rerender(<DraftText editor={editor} enabled />);
  expect(view.container.textContent).toBe("typed while off");

  view.rerender(<DraftText editor={editor} enabled={false} />);
  expect(view.container.textContent).toBe("");
});

test("switching to another editor reads that editor at once", () => {
  const first = createEditor("first editor");
  const second = createEditor("second editor");
  const view = render(<DraftText editor={first} enabled />);
  view.rerender(<DraftText editor={second} enabled />);
  expect(view.container.textContent).toBe("second editor");

  replaceText(first, "stale update");
  expect(view.container.textContent).toBe("second editor");
});
