import { Result } from "better-result";
import { expect, test } from "bun:test";
import { isTag, isText } from "domhandler";
import { readdirSync } from "node:fs";

import { DECISION_TEXT_FIELD_KEYS } from "@stll/api-contract/case-law-text-field";
import { load } from "@stll/html";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  absentTextComparison,
  readDecisionTextMetadata,
  SOURCE_ABSENT_TEXT,
  sourceTextField,
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@/api/lib/case-law/decision-text";
import { PROVENANCE_SUFFIX } from "@/api/tests/fixture-provenance";

const utf8 = new TextDecoder();
const hasProse = (text: string) => /[\p{L}\p{N}]/u.test(text);
const declaredSentences = SOURCE_ABSENT_TEXT.filter(({ text }) =>
  hasProse(text),
);
const declaredPunctuation = SOURCE_ABSENT_TEXT.filter(
  ({ text }) => !hasProse(text),
);

test("a declared marker reads as no text at all, for the source that prints it", () => {
  for (const { adapter, text } of SOURCE_ABSENT_TEXT) {
    expect(sourceTextField(adapter, text)).toEqual({
      type: TEXT_FIELD_TYPE.ABSENT,
      reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
    });
  }
});

test("another source's rows keep the same words", () => {
  // A marker is one publisher's way of saying a field is empty. Read as
  // absence everywhere, it would strip a field another publisher means, and
  // the repair over stored rows would undo what that publisher's own adapter
  // writes back on the next crawl.
  for (const { adapter, text } of declaredSentences) {
    expect(adapter).not.toBe(ADAPTER_KEYS.CZ_NS);
    expect(sourceTextField(ADAPTER_KEYS.CZ_NS, text)).toEqual({
      type: TEXT_FIELD_TYPE.PRESENT,
      text,
    });
  }
});

test("punctuation-only markers follow the existing filler policy for every adapter", () => {
  for (const { text } of declaredPunctuation) {
    for (const adapter of Object.values(ADAPTER_KEYS)) {
      expect(sourceTextField(adapter, text)).toEqual({
        type: TEXT_FIELD_TYPE.ABSENT,
        reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
      });
    }
  }
});

test("stored punctuation text is preserved by the adapter-independent reader", () => {
  for (const { text } of declaredPunctuation) {
    for (const field of DECISION_TEXT_FIELD_KEYS) {
      expect(
        readDecisionTextMetadata({ [field]: text }).textFields[field],
      ).toEqual({
        type: TEXT_FIELD_TYPE.PRESENT,
        text,
      });
    }
  }
});

test("shared empty values remain not published for every adapter", () => {
  for (const adapter of Object.values(ADAPTER_KEYS)) {
    for (const value of [undefined, null, "", " \n\t ", "\u00a0"]) {
      expect(sourceTextField(adapter, value)).toEqual({
        type: TEXT_FIELD_TYPE.ABSENT,
        reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
      });
    }
  }
});

test("the markup around a marker does not make it text", () => {
  // What a cell reads back as: the newlines the page indents its rows with,
  // and the runs of space a browser would collapse.
  expect(
    sourceTextField(
      ADAPTER_KEYS.CZ_US,
      "\r\n   Právní   věta\n není k dispozici.  \r\n",
    ),
  ).toEqual({
    type: TEXT_FIELD_TYPE.ABSENT,
    reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
  });
});

test("a publisher's own sentence is kept exactly as published", () => {
  // The comparison collapses whitespace; the value must not. A headnote is
  // stored, indexed and displayed as the publisher wrote it, paragraphs and
  // all, so only the surrounding markup is trimmed away.
  const headnote = "Věta první.\n\n  Věta druhá.";
  expect(sourceTextField(ADAPTER_KEYS.CZ_US, `\n${headnote}\n`)).toEqual({
    type: TEXT_FIELD_TYPE.PRESENT,
    text: headnote,
  });
});

test("an empty cell is absence, not an empty headnote", () => {
  expect(sourceTextField(ADAPTER_KEYS.CZ_US, "")).toEqual({
    type: TEXT_FIELD_TYPE.ABSENT,
    reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  });
  expect(sourceTextField(ADAPTER_KEYS.CZ_US, "  \n\t ")).toEqual({
    type: TEXT_FIELD_TYPE.ABSENT,
    reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  });
});

test("a sentence that only starts like a marker is text", () => {
  // The comparison is exact: a decision whose headnote opens with the same
  // words is a headnote, and losing it would be worse than the defect.
  const headnote =
    "Právní věta není k dispozici v jazyce, ve kterém byla vydána.";
  expect(sourceTextField(ADAPTER_KEYS.CZ_US, headnote)).toEqual({
    type: TEXT_FIELD_TYPE.PRESENT,
    text: headnote,
  });
});

/** Every committed capture of `adapter`'s publisher, as served. */
const capturesOf = async (adapter: string): Promise<string[]> => {
  const directory = new URL("__fixtures__/", import.meta.url);
  const names = readdirSync(directory).filter(
    (name) =>
      name.startsWith(`${adapter}-`) && !name.endsWith(PROVENANCE_SUFFIX),
  );
  const captures: string[] = [];
  for (const name of names) {
    const bytes = await Bun.file(new URL(name, directory)).bytes();
    captures.push(
      utf8.decode(name.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes),
    );
  }
  return captures;
};

/** Each element's own text and each attribute value in a piece of markup. */
const markupValues = (markup: string): string[] => {
  const $ = load(markup);
  const values: string[] = [];
  $("*").each((_, element) => {
    if (!isTag(element)) {
      return;
    }
    values.push(
      element.children
        .flatMap((child) => (isText(child) ? [child.data] : []))
        .join(""),
      ...Object.values(element.attribs),
    );
  });
  return values;
};

/**
 * Every value a capture states that could hold `marker`, decoded: each JSON
 * string, and in markup (served as is, or inside a JSON string) each
 * element's own text and attribute. Escapes are undone before comparing, so
 * `"brak\npodstaw"` is the value "brak⏎podstaw", never "brak".
 */
const statedValues = (capture: string, marker: string): string[] => {
  const probe = absentTextComparison(marker).split(" ").at(0) ?? marker;
  if (!capture.includes(probe)) {
    return [];
  }
  // A page can be recorded as JSON holding JSON holding HTML; each layer is
  // decoded in turn.
  const decode = (text: string): string[] => {
    const parsed = Result.try((): unknown => JSON.parse(text));
    if (Result.isError(parsed)) {
      return text.includes("<") ? [text, ...markupValues(text)] : [text];
    }
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        if (value.includes(probe)) {
          strings.push(value, ...decode(value));
        }
      } else if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) {
          walk(child);
        }
      }
    };
    walk(parsed.value);
    return strings;
  };
  return decode(capture);
};

const statesMarker = (capture: string, marker: string): boolean =>
  statedValues(capture, marker).some(
    (value) => absentTextComparison(value) === absentTextComparison(marker),
  );

test("a marker counts as recorded only as a whole value", () => {
  expect(statesMarker('{"summary":"brak"}', "brak")).toBe(true);
  expect(statesMarker("<thesis> brak </thesis>", "brak")).toBe(true);
  expect(statesMarker(String.raw`{"summary":"brak\npodstaw"}`, "brak")).toBe(
    false,
  );
  expect(statesMarker("<p>brak podstaw</p>", "brak")).toBe(false);
});

test("every declared sentence is one its source is recorded printing", async () => {
  // Symbol-only filler is source-independent and tested for every adapter
  // above. Source-specific sentences must match a captured page. This reads
  // them back out of the committed captures of that publisher, as the whole
  // value of a field, so a source that rewords its sentence fails here on the
  // next fixture refresh instead of silently storing the new wording as a
  // headnote, and a marker that is an ordinary word ("brak") is not vouched
  // for by any sentence that happens to contain it.
  for (const { adapter, text } of declaredSentences) {
    const captures = await capturesOf(adapter);
    expect(captures.some((capture) => statesMarker(capture, text))).toBe(true);
  }
});
