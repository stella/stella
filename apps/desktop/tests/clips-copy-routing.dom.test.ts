import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { ClipsSelection } from "../src/clipboard/clips-copy-routing";

GlobalRegistrator.register({ url: "http://localhost/" });

const { clipsSelection, installClipsCopyRouting } =
  await import("../src/clipboard/clips-copy-routing");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

/** The routing calls `write` synchronously inside the copy event. */
const install = (windowLabel: string) => {
  const writes: ClipsSelection[] = [];
  const failures: unknown[] = [];
  cleanups.push(
    installClipsCopyRouting({
      document,
      windowLabel,
      write: async (selection) => {
        writes.push(selection);
        await Promise.resolve();
      },
      onFailure: (error) => {
        failures.push(error);
      },
    }),
  );
  return { failures, writes };
};

const selectContents = (element: Element) => {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

const editorWithText = () => {
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  const bold = document.createElement("b");
  bold.textContent = "Clause 4";
  editor.append(bold);
  document.body.append(editor);
  return editor;
};

const dispatchClipboardEvent = (type: "copy" | "cut") => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
};

/** Records editing commands; `deleted` resolves on the first one. */
const recordDeletes = () => {
  const deletes: string[] = [];
  const deleted = Promise.withResolvers<undefined>();
  const original: unknown = Reflect.get(document, "execCommand");
  Reflect.set(document, "execCommand", (command: string) => {
    deletes.push(command);
    deleted.resolve(undefined);
    return true;
  });
  cleanups.push(() => {
    Reflect.set(document, "execCommand", original);
  });
  return { deleted: deleted.promise, deletes };
};

describe("copies inside the Clips windows", () => {
  for (const windowLabel of ["clipboard", "clipboard-editor"]) {
    test(`${windowLabel} writes the selection itself instead of a native copy`, () => {
      const { failures, writes } = install(windowLabel);
      selectContents(editorWithText());

      const event = dispatchClipboardEvent("copy");

      expect(event.defaultPrevented).toBe(true);
      expect(writes).toEqual([
        { html: "<b>Clause 4</b>", plainText: "Clause 4" },
      ]);
      expect(failures).toEqual([]);
    });
  }

  test("other windows keep the native copy", () => {
    const { writes } = install("activity");
    selectContents(editorWithText());

    const event = dispatchClipboardEvent("copy");

    expect(event.defaultPrevented).toBe(false);
    expect(writes).toEqual([]);
  });

  test("an empty selection leaves the native copy alone", () => {
    const { writes } = install("clipboard-editor");

    const event = dispatchClipboardEvent("copy");

    expect(event.defaultPrevented).toBe(false);
    expect(writes).toEqual([]);
  });

  test("a text field copies only its selected plain text", () => {
    const field = document.createElement("input");
    field.value = "find clause 4";
    document.body.append(field);
    field.focus();
    field.setSelectionRange(5, 11);

    expect(clipsSelection(document)).toEqual({
      html: null,
      plainText: "clause",
    });
  });

  test("a password field is never copied", () => {
    const field = document.createElement("input");
    field.type = "password";
    field.value = "secret";
    document.body.append(field);
    field.focus();
    field.setSelectionRange(0, 6);

    expect(clipsSelection(document)).toBeNull();
  });

  test("a failed write is reported and a cut deletes nothing", async () => {
    const { deletes } = recordDeletes();
    const failed = Promise.withResolvers<unknown>();
    cleanups.push(
      installClipsCopyRouting({
        document,
        windowLabel: "clipboard-editor",
        write: async () => await Promise.reject(new Error("clipboard busy")),
        onFailure: (error) => failed.resolve(error),
      }),
    );
    selectContents(editorWithText());

    const event = dispatchClipboardEvent("cut");

    expect(event.defaultPrevented).toBe(true);
    expect(await failed.promise).toEqual(new Error("clipboard busy"));
    expect(deletes).toEqual([]);
  });

  test("a cut deletes the selection once it is on the clipboard", async () => {
    const { deleted, deletes } = recordDeletes();
    const { writes } = install("clipboard-editor");
    selectContents(editorWithText());

    dispatchClipboardEvent("cut");
    await deleted;

    expect(writes).toHaveLength(1);
    expect(deletes).toEqual(["delete"]);
  });
});
