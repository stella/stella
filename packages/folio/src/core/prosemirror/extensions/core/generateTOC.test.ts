import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import { schema, singletonManager } from "../../schema";

const docWithHeadings = (): PMNode =>
  schema.node("doc", null, [
    schema.node("paragraph", { styleId: "Heading1" }, [
      schema.text("Introduction"),
    ]),
    schema.node("paragraph", {}, [schema.text("Body text.")]),
    schema.node("paragraph", { styleId: "Heading2" }, [
      schema.text("Background"),
    ]),
  ]);

const runGenerateTOC = (doc: PMNode): PMNode => {
  const generateTOC = singletonManager.getCommands()["generateTOC"];
  if (!generateTOC) {
    throw new Error("generateTOC command not registered");
  }
  let state = EditorState.create({ schema, doc });
  state = state.apply(state.tr.setSelection(TextSelection.atStart(state.doc)));

  let captured: Transaction | undefined;
  const ok = generateTOC()(state, (tr) => {
    captured = tr;
  });
  expect(ok).toBe(true);
  if (!captured) {
    throw new Error("generateTOC did not dispatch a transaction");
  }
  return captured.doc;
};

const tocEntryParagraphs = (doc: PMNode): PMNode[] => {
  const entries: PMNode[] = [];
  doc.descendants((node) => {
    const styleId = node.attrs["styleId"];
    if (
      node.type.name === "paragraph" &&
      typeof styleId === "string" &&
      /^TOC\d$/u.test(styleId)
    ) {
      entries.push(node);
    }
  });
  return entries;
};

describe("generateTOC", () => {
  test("creates one entry per heading with a PAGEREF field and a dot-leader right tab", () => {
    const result = runGenerateTOC(docWithHeadings());
    const entries = tocEntryParagraphs(result);

    expect(entries).toHaveLength(2);

    for (const entry of entries) {
      let pagerefInstruction: string | undefined;
      let hasTab = false;
      entry.descendants((node) => {
        if (
          node.type.name === "field" &&
          node.attrs["fieldType"] === "PAGEREF"
        ) {
          pagerefInstruction = node.attrs["instruction"] as string;
        }
        if (node.type.name === "tab") {
          hasTab = true;
        }
      });

      // PAGEREF points at a generated heading bookmark.
      expect(pagerefInstruction).toMatch(/^PAGEREF _Toc\d+ \\h$/u);
      expect(hasTab).toBe(true);

      const tabs = entry.attrs["tabs"] as
        | { alignment?: string; leader?: string }[]
        | null;
      expect(
        tabs?.some((t) => t.alignment === "right" && t.leader === "dot"),
      ).toBe(true);
    }
  });

  test("each entry's PAGEREF targets a bookmark anchored on a heading", () => {
    const result = runGenerateTOC(docWithHeadings());

    // Bookmark names anchored on heading paragraphs.
    const headingBookmarks = new Set<string>();
    result.descendants((node) => {
      if (node.type.name !== "paragraph") {
        return;
      }
      const styleId = node.attrs["styleId"];
      if (typeof styleId === "string" && /^Heading\d$/u.test(styleId)) {
        const bookmarks = node.attrs["bookmarks"] as
          | { name: string }[]
          | undefined;
        for (const b of bookmarks ?? []) {
          headingBookmarks.add(b.name);
        }
      }
    });

    const entries = tocEntryParagraphs(result);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      let target: string | undefined;
      entry.descendants((node) => {
        if (
          node.type.name === "field" &&
          node.attrs["fieldType"] === "PAGEREF"
        ) {
          target = /^PAGEREF (\S+) /u.exec(
            node.attrs["instruction"] as string,
          )?.[1];
        }
      });
      expect(target).toBeDefined();
      // The referenced bookmark really exists on a heading, so the page map
      // resolves it at paint.
      expect(headingBookmarks.has(target as string)).toBe(true);
    }
  });
});
