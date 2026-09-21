import { describe, expect, test } from "bun:test";

import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";

import {
  boundLegalDocumentLabel,
  chatContextLabel,
  chatTabHeaderLabel,
} from "./chat-context-label.logic";

const decision: ActiveLegalDocument = {
  type: "decision",
  caseNumber: "Mfv.10127/2026/4",
  decisionId: "decision-1",
};

const labelOf = (
  overrides: Partial<Parameters<typeof chatContextLabel>[0]> = {},
) =>
  chatContextLabel({
    activeSkillName: undefined,
    boundDocumentLabel: undefined,
    matterNames: [],
    newChatLabel: "New chat",
    tabLabel: "New chat",
    ...overrides,
  });

describe("how a bound document is named", () => {
  test("names the decision the tab is bound to while it is on screen", () => {
    expect(
      boundLegalDocumentLabel({
        activeLegalKey: "decision:decision-1",
        mainDocument: decision,
      }),
    ).toBe("Mfv.10127/2026/4");
  });

  test("names nothing once the reader moved to another decision", () => {
    expect(
      boundLegalDocumentLabel({
        activeLegalKey: "decision:decision-2",
        mainDocument: decision,
      }),
    ).toBeUndefined();
  });

  test("names nothing for a chat bound to no document", () => {
    expect(
      boundLegalDocumentLabel({
        activeLegalKey: undefined,
        mainDocument: decision,
      }),
    ).toBeUndefined();
  });
});

describe("what the composer says the chat is about", () => {
  test("the active skill comes first", () => {
    expect(
      labelOf({
        activeSkillName: "Redline",
        boundDocumentLabel: "Mfv.10127/2026/4",
        matterNames: ["Novák v. Dvořák"],
      }),
    ).toBe("Redline");
  });

  test("the bound document beats the matters in context", () => {
    expect(
      labelOf({
        boundDocumentLabel: "Mfv.10127/2026/4",
        matterNames: ["Novák v. Dvořák"],
      }),
    ).toBe("Mfv.10127/2026/4");
  });

  test("the matters in context beat the thread's title", () => {
    expect(
      labelOf({ matterNames: ["Novák v. Dvořák"], tabLabel: "Lease renewal" }),
    ).toBe("Novák v. Dvořák");
  });

  test("more than one matter counts the rest", () => {
    expect(labelOf({ matterNames: ["Novák v. Dvořák", "Kovács"] })).toBe(
      "Novák v. Dvořák +1",
    );
  });

  test("falls back to the thread's title", () => {
    expect(labelOf({ tabLabel: "Lease renewal" })).toBe("Lease renewal");
  });

  test("falls back to the untitled name while the thread has no title", () => {
    expect(labelOf()).toBe("New chat");
  });
});

describe("what the tab header names", () => {
  test("names the bound document while the thread is untitled", () => {
    expect(
      chatTabHeaderLabel({
        boundDocumentLabel: "Mfv.10127/2026/4",
        newChatLabel: "New chat",
        tabLabel: "New chat",
      }),
    ).toBe("Mfv.10127/2026/4");
  });

  test("keeps the thread's own title once it has one", () => {
    expect(
      chatTabHeaderLabel({
        boundDocumentLabel: "Mfv.10127/2026/4",
        newChatLabel: "New chat",
        tabLabel: "Limitation period",
      }),
    ).toBe("Limitation period");
  });
});
