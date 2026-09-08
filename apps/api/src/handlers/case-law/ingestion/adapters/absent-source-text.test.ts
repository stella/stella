import { expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  SOURCE_ABSENT_TEXT,
  absentTextComparison,
  sourceTextOrAbsent,
} from "@/api/handlers/case-law/ingestion/adapters/absent-source-text";
import { readGzipJson } from "@/api/lib/gzip-json";

test("a declared marker reads as no text at all, for the source that prints it", () => {
  for (const { adapter, text } of SOURCE_ABSENT_TEXT) {
    expect(sourceTextOrAbsent(adapter, text)).toBeUndefined();
  }
});

test("another source's rows keep the same words", () => {
  // A marker is one publisher's way of saying a field is empty. Read as
  // absence everywhere, it would strip a field another publisher means, and
  // the repair over stored rows would undo what that publisher's own adapter
  // writes back on the next crawl.
  for (const { adapter, text } of SOURCE_ABSENT_TEXT) {
    expect(adapter).not.toBe(ADAPTER_KEYS.CZ_NS);
    expect(sourceTextOrAbsent(ADAPTER_KEYS.CZ_NS, text)).toBe(text);
  }
});

test("the markup around a marker does not make it text", () => {
  // What a cell reads back as: the newlines the page indents its rows with,
  // and the runs of space a browser would collapse.
  expect(
    sourceTextOrAbsent(
      ADAPTER_KEYS.CZ_US,
      "\r\n   Právní   věta\n není k dispozici.  \r\n",
    ),
  ).toBeUndefined();
});

test("a publisher's own sentence is kept exactly as published", () => {
  // The comparison collapses whitespace; the value must not. A headnote is
  // stored, indexed and displayed as the publisher wrote it, paragraphs and
  // all, so only the surrounding markup is trimmed away.
  const headnote = "Věta první.\n\n  Věta druhá.";
  expect(sourceTextOrAbsent(ADAPTER_KEYS.CZ_US, `\n${headnote}\n`)).toBe(
    headnote,
  );
});

test("an empty cell is absence, not an empty headnote", () => {
  expect(sourceTextOrAbsent(ADAPTER_KEYS.CZ_US, "")).toBeUndefined();
  expect(sourceTextOrAbsent(ADAPTER_KEYS.CZ_US, "  \n\t ")).toBeUndefined();
});

test("a sentence that only starts like a marker is text", () => {
  // The comparison is exact: a decision whose headnote opens with the same
  // words is a headnote, and losing it would be worse than the defect.
  const headnote =
    "Právní věta není k dispozici v jazyce, ve kterém byla vydána.";
  expect(sourceTextOrAbsent(ADAPTER_KEYS.CZ_US, headnote)).toBe(headnote);
});

test("every declared marker is a sentence its source is recorded printing", async () => {
  // The declarations are only worth anything while they match the page. This
  // reads them back out of the committed capture of that page, so a source
  // that rewords its sentence fails here on the next fixture refresh instead
  // of silently storing the new wording as a headnote.
  const fixtures = new Map<string, string>();
  const captureOf = async (adapter: string): Promise<string> => {
    const held = fixtures.get(adapter);
    if (held !== undefined) {
      return held;
    }
    const capture = JSON.stringify(
      await readGzipJson(
        new URL(`__fixtures__/${adapter}-page.json.gz`, import.meta.url),
      ),
    );
    fixtures.set(adapter, capture);
    return capture;
  };

  for (const { adapter, text } of SOURCE_ABSENT_TEXT) {
    const capture = await captureOf(adapter);
    expect(capture).toContain(absentTextComparison(text));
  }
});
