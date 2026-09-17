/**
 * The reviewer types a counterparty note into a popover and nowhere else, so
 * the outcome of the write decides whether that text survives. These cover the
 * invariant that made the note disappear: every outcome that is not "in the
 * document" has to answer `applied: false` and carry a message.
 */

import { describe, expect, test } from "bun:test";

import type { DocxEditModeBlockReason } from "@/components/docx/docx-browser-editor.logic";
import {
  COUNTERPARTY_NOTE_BLOCKED_MESSAGES,
  reportCounterpartyNote,
} from "@/components/inspector/counterparty-note.logic";
import messages from "@/i18n/langs/en.json";
import type { TranslationKey } from "@/i18n/types";

const EVERY_BLOCK_REASON = [
  "pendingCompatibility",
  "unsafe",
  "collaboration",
  "opening",
] as const satisfies readonly DocxEditModeBlockReason[];

const catalogEntry = (key: TranslationKey): unknown => {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      return undefined;
    }
    node = Object.getOwnPropertyDescriptor(node, part)?.value;
  }
  return node;
};

describe("counterparty note outcomes", () => {
  test("the reason list covers every blocked reason the map declares", () => {
    expect(new Set<string>(EVERY_BLOCK_REASON)).toEqual(
      new Set(Object.keys(COUNTERPARTY_NOTE_BLOCKED_MESSAGES)),
    );
  });

  test("a blocked edit-mode request never counts the note as written", () => {
    for (const reason of EVERY_BLOCK_REASON) {
      const report = reportCounterpartyNote({ type: "blocked", reason });
      expect(report.applied).toBe(false);
      expect(report.description).toBeDefined();
    }
  });

  test("every outcome names a message the catalog can render", () => {
    const reports = [
      reportCounterpartyNote({ type: "applied" }),
      reportCounterpartyNote({ type: "failed" }),
      ...EVERY_BLOCK_REASON.map((reason) =>
        reportCounterpartyNote({ type: "blocked", reason }),
      ),
    ];
    for (const { title, description } of reports) {
      expect(typeof catalogEntry(title)).toBe("string");
      if (description !== undefined) {
        expect(typeof catalogEntry(description)).toBe("string");
      }
    }
  });

  test("an unsafe document reuses the wording the editor already shows", () => {
    expect(
      reportCounterpartyNote({ type: "blocked", reason: "unsafe" }).description,
    ).toBe("folio.unsupportedDocxEditDescription");
  });

  test("only a written note reports as applied", () => {
    expect(reportCounterpartyNote({ type: "applied" }).applied).toBe(true);
    expect(reportCounterpartyNote({ type: "failed" }).applied).toBe(false);
  });
});
