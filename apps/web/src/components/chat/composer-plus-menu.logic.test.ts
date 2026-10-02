import { Schema } from "@tiptap/pm/model";
import { describe, expect, test } from "bun:test";

import { typedCharacter } from "@stll/ui/typed-character";

import {
  charBeforeCaret,
  COMPOSER_MENU_SHORTCUT,
  contextMentionSearchKey,
  resolveComposerMenuShortcut,
  shouldDrainSkillPages,
} from "@/components/chat/composer-plus-menu.logic";

const baseOptions = {
  charBeforeCaret: null,
  hasContext: true,
  hasSkills: true,
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

const resolveAfterText = (text: string, character: string) =>
  resolveComposerMenuShortcut({
    ...baseOptions,
    charBeforeCaret: charBeforeCaret(
      caretAfter(text ? [schema.text(text)] : []),
    ),
    character,
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
        character: "/",
      }),
    ).toBe(COMPOSER_MENU_SHORTCUT.skills);

    const afterChip = charBeforeCaret(caretAfter([schema.node("mention")]));
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        charBeforeCaret: afterChip,
        character: "@",
      }),
    ).toBeNull();
  });

  test("does not intercept unavailable menus", () => {
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        hasSkills: false,
        character: "/",
      }),
    ).toBeNull();
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        hasContext: false,
        character: "@",
      }),
    ).toBeNull();
  });

  test("ignores absent and unrelated typed characters", () => {
    for (const character of [null, "a", "😀", " "]) {
      expect(
        resolveComposerMenuShortcut({ ...baseOptions, character }),
      ).toBeNull();
    }
  });

  // Which keystrokes type a character is typedCharacter's contract, pinned
  // per layout next to it; this checks the composer consumes it.
  test("opens for an Option-typed trigger and keeps Cmd shortcuts", () => {
    const keystroke = (modifiers: { altKey: boolean; metaKey: boolean }) =>
      typedCharacter({
        ...modifiers,
        ctrlKey: false,
        getModifierState: () => false,
        isComposing: false,
        key: "@",
      });

    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        character: keystroke({ altKey: true, metaKey: false }),
      }),
    ).toBe(COMPOSER_MENU_SHORTCUT.context);
    expect(
      resolveComposerMenuShortcut({
        ...baseOptions,
        character: keystroke({ altKey: false, metaKey: true }),
      }),
    ).toBeNull();
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
