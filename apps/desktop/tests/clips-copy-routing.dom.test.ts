import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { ClipsSelection } from "../src/clipboard/clips-copy-routing";

GlobalRegistrator.register({ url: "http://localhost/" });

const { clipsSelection, installClipsCopyRouting, isClipsCopyFailed } =
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

/** Selects a span of one text node, or of two when `endText` is given. */
const selectText = (
  startText: Node,
  startOffset: number,
  endOffset: number,
  endText: Node = startText,
) => {
  const range = document.createRange();
  range.setStart(startText, startOffset);
  range.setEnd(endText, endOffset);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

/** A clip's content root holding `html`, as both Clips windows render it. */
const clipWithHtml = (html: string) => {
  const clip = document.createElement("div");
  clip.className = "clipboard-html";
  // safe-html: every caller passes a literal fixture from this file.
  clip.innerHTML = html;
  document.body.append(clip);
  return clip;
};

const firstText = (root: Element, selector: string) => {
  const text = root.querySelector(selector)?.firstChild;
  if (!text) {
    throw new TypeError(`No text in ${selector}`);
  }
  return text;
};

/**
 * Resolves after the routing's reaction to a settled write has run. That
 * reaction takes a few microtasks and no timer, so no clock is involved.
 */
const afterMicrotasks = async (remaining = 10): Promise<void> => {
  if (remaining > 0) {
    await afterMicrotasks(remaining - 1);
  }
};

/** Installs routing whose write settles only when the test says so. */
const installHeldWrite = () => {
  const held = Promise.withResolvers<undefined>();
  cleanups.push(
    installClipsCopyRouting({
      document,
      windowLabel: "clipboard-editor",
      write: async () => await held.promise,
      onFailure: () => undefined,
    }),
  );
  return {
    settle: async () => {
      held.resolve(undefined);
      await afterMicrotasks();
    },
  };
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

  test("a cut deletes nothing once focus moved to the same text in another field", async () => {
    const { deletes } = recordDeletes();
    const [first, second] = ["clause", "clause"].map((value) => {
      const field = document.createElement("input");
      field.value = value;
      document.body.append(field);
      return field;
    });
    if (!first || !second) {
      throw new TypeError("Missing fields");
    }
    const held = installHeldWrite();
    first.focus();
    first.setSelectionRange(0, 6);

    dispatchClipboardEvent("cut");
    second.focus();
    second.setSelectionRange(0, 6);
    await held.settle();

    expect(deletes).toEqual([]);
  });

  test("a cut deletes nothing once the same text is selected elsewhere in the field", async () => {
    const { deletes } = recordDeletes();
    const field = document.createElement("textarea");
    field.value = "clause clause";
    document.body.append(field);
    const held = installHeldWrite();
    field.focus();
    field.setSelectionRange(0, 6);

    dispatchClipboardEvent("cut");
    field.setSelectionRange(7, 13);
    await held.settle();

    expect(deletes).toEqual([]);
  });

  test("a cut deletes nothing once the same text is selected elsewhere in the editor", async () => {
    const { deletes } = recordDeletes();
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.innerHTML = "<p>clause</p><p>clause</p>";
    document.body.append(editor);
    const held = installHeldWrite();
    selectText(firstText(editor, "p:first-child"), 0, 6);

    dispatchClipboardEvent("cut");
    selectText(firstText(editor, "p:last-child"), 0, 6);
    await held.settle();

    expect(deletes).toEqual([]);
  });
});

describe("a selection keeps the formatting around it", () => {
  test("inside one formatted run", () => {
    const clip = clipWithHtml("<p>See <b>Clause 4</b> here</p>");

    selectText(firstText(clip, "b"), 0, 6);

    expect(clipsSelection(document)).toEqual({
      html: "<b>Clause</b>",
      plainText: "Clause",
    });
  });

  test("inside nested runs, outermost first", () => {
    const clip = clipWithHtml("<b><i>Clause 4</i></b>");

    selectText(firstText(clip, "i"), 7, 8);

    expect(clipsSelection(document)?.html).toBe("<b><i>4</i></b>");
  });

  test("across children of a formatted run", () => {
    const clip = clipWithHtml(
      "<strong><u>Clause</u> 4 <em>applies</em></strong>",
    );

    selectText(firstText(clip, "u"), 0, 3, firstText(clip, "em"));

    expect(clipsSelection(document)?.html).toBe(
      "<strong><u>Clause</u> 4 <em>app</em></strong>",
    );
  });

  test("with its inline style attribute", () => {
    const clip = clipWithHtml('<span style="color: red">Clause 4</span>');

    selectText(firstText(clip, "span"), 0, 6);

    expect(clipsSelection(document)?.html).toBe(
      '<span style="color: red">Clause</span>',
    );
  });

  test("not the paragraph it sits in", () => {
    const clip = clipWithHtml("<p>Clause 4</p>");

    selectText(firstText(clip, "p"), 0, 6);

    expect(clipsSelection(document)?.html).toBe("Clause");
  });

  test("a word inside a table cell or list item stays inline", () => {
    const table = clipWithHtml(
      "<table><tbody><tr><td><b>Clause 4</b></td></tr></tbody></table>",
    );
    selectText(firstText(table, "b"), 0, 6);
    expect(clipsSelection(document)?.html).toBe("<b>Clause</b>");

    const list = clipWithHtml("<ul><li>Clause 4</li></ul>");
    selectText(firstText(list, "li"), 0, 6);
    expect(clipsSelection(document)?.html).toBe("Clause");
  });

  test("list items keep their list", () => {
    const clip = clipWithHtml("<ol><li>one</li><li>two</li></ol>");

    selectText(
      firstText(clip, "li:first-child"),
      0,
      3,
      firstText(clip, "li:last-child"),
    );

    expect(clipsSelection(document)?.html).toBe(
      "<ol><li>one</li><li>two</li></ol>",
    );
  });

  test("table cells keep their table", () => {
    const clip = clipWithHtml(
      "<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>",
    );

    selectText(
      firstText(clip, "td:first-child"),
      0,
      3,
      firstText(clip, "td:last-child"),
    );

    expect(clipsSelection(document)?.html).toBe(
      "<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>",
    );
  });

  test("the content root and whatever is outside it stay out", () => {
    const outer = document.createElement("section");
    outer.innerHTML =
      '<b><div class="clipboard-html">Clause</div></b><b><div class="clipboard-html">4</div></b>';
    document.body.append(outer);

    selectText(firstText(outer, "b:first-child div"), 0, 6);
    expect(clipsSelection(document)?.html).toBe("Clause");

    selectText(
      firstText(outer, "b:first-child div"),
      0,
      1,
      firstText(outer, "b:last-child div"),
    );
    expect(clipsSelection(document)?.html).toBe(
      '<b><div class="clipboard-html">Clause</div></b><b><div class="clipboard-html">4</div></b>',
    );
  });

  test("text outside any clip is copied as selected", () => {
    const label = document.createElement("b");
    label.textContent = "Clause 4";
    document.body.append(label);
    const text = label.firstChild;
    if (!text) {
      throw new TypeError("Missing label text");
    }

    selectText(text, 0, 6);

    expect(clipsSelection(document)?.html).toBe("Clause");
  });
});

describe("a copy that never reached the clipboard", () => {
  /** The first write fails; `failed` resolves once the routing reported it. */
  const installFailingOnce = () => {
    const failed = Promise.withResolvers<undefined>();
    let failing = true;
    cleanups.push(
      installClipsCopyRouting({
        document,
        windowLabel: "clipboard",
        write: async () => {
          if (failing) {
            failing = false;
            throw new Error("clipboard busy");
          }
          await Promise.resolve();
        },
        onFailure: () => failed.resolve(undefined),
      }),
    );
    return { failed: failed.promise };
  };

  test("is flagged until the next copy", async () => {
    const { failed } = installFailingOnce();
    selectContents(editorWithText());
    expect(isClipsCopyFailed()).toBe(false);

    dispatchClipboardEvent("copy");
    await failed;
    expect(isClipsCopyFailed()).toBe(true);

    dispatchClipboardEvent("copy");
    expect(isClipsCopyFailed()).toBe(false);
  });

  test("stops being flagged once the user leaves the window", async () => {
    const { failed } = installFailingOnce();
    selectContents(editorWithText());

    dispatchClipboardEvent("copy");
    await failed;
    expect(isClipsCopyFailed()).toBe(true);

    window.dispatchEvent(new Event("blur"));
    expect(isClipsCopyFailed()).toBe(false);
  });
});
