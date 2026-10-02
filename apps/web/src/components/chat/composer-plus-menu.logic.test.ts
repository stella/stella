import { Schema } from "@tiptap/pm/model";
import { describe, expect, test } from "bun:test";

import {
  charBeforeCaret,
  COMPOSER_MENU_SHORTCUT,
  contextMentionSearchKey,
  resolveComposerMenuShortcut,
  shouldDrainSkillPages,
} from "@/components/chat/composer-plus-menu.logic";

const baseOptions = {
  altKey: false,
  charBeforeCaret: null,
  ctrlKey: false,
  hasContext: true,
  hasSkills: true,
  isAltGraph: false,
  isComposing: false,
  metaKey: false,
};

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*" },
    text: { group: "inline", inline: true },
    hardBreak: { group: "inline", inline: true },
    mention: { atom: true, group: "inline", inline: true },
  },
});

// Resolves the caret at the end of a single paragraph holding `children`.
const caretAfter = (children: Parameters<typeof schema.node>[2]) => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, children),
  ]);
  const paragraph = doc.firstChild;
  if (!paragraph) {
    throw new Error("Expected a paragraph");
  }
  return doc.resolve(1 + paragraph.content.size);
};

const resolveAfterText = (text: string, key: string) =>
  resolveComposerMenuShortcut({
    ...baseOptions,
    charBeforeCaret: charBeforeCaret(
      caretAfter(text ? [schema.text(text)] : []),
    ),
    key,
  });

describe("resolveComposerMenuShortcut", () => {
  test("opens Skills for slash in a blank skills-enabled composer", () => {
    expect(resolveAfterText("", "/")).toBe(COMPOSER_MENU_SHORTCUT.skills);
  });

  test("opens Context for at-sign in a blank context-enabled composer", () => {
    expect(resolveAfterText("", "@")).toBe(COMPOSER_MENU_SHORTCUT.context);
  });

  test("opens after every JavaScript whitespace character", () => {
    const whitespaceCharacters = [
      "\u0009",
      "\u000b",
      "\u000c",
      " ",
      "\u00a0",
      "\u1680",
      "\u2000",
      "\u2001",
      "\u2002",
      "\u2003",
      "\u2004",
      "\u2005",
      "\u2006",
      "\u2007",
      "\u2008",
      "\u2009",
      "\u200a",
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
    ];

    for (const whitespace of whitespaceCharacters) {
      expect(resolveAfterText(`review${whitespace}`, "@")).toBe(
        COMPOSER_MENU_SHORTCUT.context,
      );
      expect(resolveAfterText(`review${whitespace}`, "/")).toBe(
        COMPOSER_MENU_SHORTCUT.skills,
      );
    }
  });

  test("keeps the character literal inside words, addresses and URLs", () => {
    for (const prefix of ["and", "jan", "person.example", "clause-", "a_"]) {
      expect(resolveAfterText(prefix, "@")).toBeNull();
      expect(resolveAfterText(prefix, "/")).toBeNull();
    }
    expect(resolveAfterText("https:", "/")).toBeNull();
  });

  test("opens after a hard break but not flush against a chip", () => {
    const afterBreak = charBeforeCaret(
      caretAfter([schema.text("first line"), schema.node("hardBreak")]),
    );
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        charBeforeCaret: afterBreak,
        key: "/",
      }),
    ).toBe(COMPOSER_MENU_SHORTCUT.skills);

    const afterChip = charBeforeCaret(caretAfter([schema.node("mention")]));
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        charBeforeCaret: afterChip,
        key: "@",
      }),
    ).toBeNull();
  });

  test("does not intercept unavailable menus", () => {
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        hasSkills: false,
        key: "/",
      }),
    ).toBeNull();
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        hasContext: false,
        key: "@",
      }),
    ).toBeNull();
  });

  test("preserves IME composition", () => {
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        isComposing: true,
        key: "/",
      }),
    ).toBeNull();
  });

  // Every modifier combination a layout can type the trigger with: Option on
  // macOS (Czech, Slovak, German "@"), AltGr on Windows (Ctrl+Alt, with or
  // without the AltGraph state), and Shift folded into `key` everywhere. Only
  // Cmd, or Ctrl without Alt, is a command chord.
  describe("modifier chords", () => {
    const flags = [false, true];
    const chords = flags.flatMap((altKey) =>
      flags.flatMap((ctrlKey) =>
        flags.flatMap((metaKey) =>
          flags.map((isAltGraph) => ({ altKey, ctrlKey, isAltGraph, metaKey })),
        ),
      ),
    );

    test.each(chords)(
      "alt=$altKey ctrl=$ctrlKey meta=$metaKey altGraph=$isAltGraph",
      (chord) => {
        const isCommandChord =
          chord.metaKey ||
          (chord.ctrlKey && !chord.altKey && !chord.isAltGraph);
        const expected = isCommandChord ? null : COMPOSER_MENU_SHORTCUT.context;

        expect(
          resolveComposerMenuShortcut({ ...baseOptions, ...chord, key: "@" }),
        ).toBe(expected);
      },
    );

    test("opens for Option-typed characters on macOS", () => {
      expect(
        resolveComposerMenuShortcut({
          ...baseOptions,
          altKey: true,
          key: "@",
        }),
      ).toBe(COMPOSER_MENU_SHORTCUT.context);
    });

    test("keeps Ctrl and Cmd shortcuts", () => {
      expect(
        resolveComposerMenuShortcut({
          ...baseOptions,
          ctrlKey: true,
          key: "/",
        }),
      ).toBeNull();
      expect(
        resolveComposerMenuShortcut({
          ...baseOptions,
          metaKey: true,
          key: "/",
        }),
      ).toBeNull();
    });
  });
});

describe("shouldDrainSkillPages", () => {
  test("keeps loading pages until a non-empty search reaches the end", () => {
    expect(
      shouldDrainSkillPages({
        hasNextPage: true,
        isFetchingNextPage: false,
        open: true,
        query: "conflict",
      }),
    ).toBe(true);

    for (const options of [
      { hasNextPage: false, isFetchingNextPage: false, open: true },
      { hasNextPage: true, isFetchingNextPage: true, open: true },
      { hasNextPage: true, isFetchingNextPage: false, open: false },
    ]) {
      expect(shouldDrainSkillPages({ ...options, query: "conflict" })).toBe(
        false,
      );
    }
    expect(
      shouldDrainSkillPages({
        hasNextPage: true,
        isFetchingNextPage: false,
        open: true,
        query: "  ",
      }),
    ).toBe(false);
  });
});

describe("contextMentionSearchKey", () => {
  const scope = {
    organizationId: "org-a",
    query: "lease",
    registrationVersion: 3,
    threadKey: "workspace:matter-a:thread-a",
    userId: "user-a",
  };

  test("the same query in another scope never shares a cache entry", () => {
    const key = JSON.stringify(contextMentionSearchKey(scope));
    for (const other of [
      { organizationId: "org-b" },
      { userId: "user-b" },
      { threadKey: "workspace:matter-b:thread-a" },
      { threadKey: "global:thread-a" },
      { registrationVersion: 4 },
    ]) {
      expect(
        JSON.stringify(contextMentionSearchKey({ ...scope, ...other })),
      ).not.toBe(key);
    }
  });

  test("a repeated search in the same scope reuses its entry", () => {
    expect(contextMentionSearchKey({ ...scope })).toEqual(
      contextMentionSearchKey(scope),
    );
  });
});
