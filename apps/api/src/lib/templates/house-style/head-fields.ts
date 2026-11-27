// The fields a memo names in its head (`To:`, `From:`, `Date:`, `Re:`) and
// the lines of a document that state them. A template for memos has a table
// with the names of the fields and an empty cell beside each; a line of the
// source that states a field goes into that cell without its own name of
// the field, which the template shows. By rule, no language model; a line
// the rules cannot read keeps its place in the body.

import type { DocxBlock } from "@/api/lib/templates/house-style/folio-contract";

export const HEAD_FIELDS = ["to", "from", "date", "subject", "cc"] as const;

export type HeadField = (typeof HEAD_FIELDS)[number];

/**
 * The words that name each field: a fixed, closed set, in the languages
 * the templates and their documents are written in. Any word of a field
 * stands for any other, so `Věc:` fills the cell beside `Subject:`. A word
 * outside the set names no field here.
 */
const FIELD_WORDS = {
  to: ["to", "komu", "an"],
  from: ["from", "od", "von"],
  date: ["date", "datum"],
  subject: ["re", "subject", "věc", "betreff"],
  cc: ["cc", "kopie"],
} as const satisfies Record<HeadField, readonly string[]>;

const fieldOfWord = (word: string): HeadField | null => {
  const lower = word.toLowerCase();
  return (
    HEAD_FIELDS.find((field) =>
      FIELD_WORDS[field].some((known) => known === lower),
    ) ?? null
  );
};

/** A field's name as a cell or a line states it: one word and a colon. */
const FIELD_NAME = /^(?<word>\p{L}{2,8})[ \u00A0]*:$/u;

/** The field a label names (`To:`, `Věc:`) and the word it names it
 *  with, or null. */
export const readFieldName = (
  label: string,
): { field: HeadField; word: string } | null => {
  const word = FIELD_NAME.exec(label.trim())?.groups?.["word"];
  const field = word === undefined ? null : fieldOfWord(word);
  return word === undefined || field === null ? null : { field, word };
};

type HeadLine = {
  field: HeadField;
  blockId: string;
  /** The field's name as the line types it, through the colon. */
  lead: string;
  /** The word alone, as typed: `Re`. */
  word: string;
};

/** How far into a document its head is looked for, in paragraphs with
 *  text, and how long a line of it is at most. */
const HEAD_MAX = 12;
const HEAD_LINE_MAX = 200;

/** One line: a value that goes on behind a line break is no value of one
 *  field for sure; a break that only ends the line is no part of it. */
const HEAD_LINE =
  /^[ \t\u00A0]*(?<lead>(?<word>\p{L}{2,8})[ \u00A0]*:)[ \t\u00A0]*(?<value>\S[^\n]*)$/u;
/** A further name of a field inside a line's value, behind a blank or a
 *  separator (`To: Jane;From: Peter`). */
const NAME_INSIDE = /(?:^|[^\p{L}\p{N}])(?<word>\p{L}{2,8})[ \u00A0]*:/gu;

/** The fields a line's value names besides its own. */
const fieldsNamedIn = (value: string): HeadField[] =>
  [...value.matchAll(NAME_INSIDE)].flatMap((match) => {
    const field = fieldOfWord(match.groups?.["word"] ?? "");
    return field === null ? [] : [field];
  });

/**
 * The lines of a document's head that state one field each: among its
 * first paragraphs with text, a field's name, a colon and a value on one
 * line. A line that names two fields is not read, and a field two lines
 * state is stated by neither: both keep their place in the body.
 */
export const readHeadLines = (topLevel: readonly DocxBlock[]): HeadLine[] => {
  const lines: HeadLine[] = [];
  // Every field a line of the head names, read or not: a field a line that
  // is not read names too is stated twice.
  const named: HeadField[] = [];
  const shown = topLevel
    .filter(({ kind, text }) => kind === "paragraph" && text.trim() !== "")
    .slice(0, HEAD_MAX);
  for (const block of shown) {
    const read =
      block.text.length <= HEAD_LINE_MAX
        ? HEAD_LINE.exec(block.text.trimEnd())?.groups
        : undefined;
    const word = read?.["word"] ?? "";
    const field = fieldOfWord(word);
    if (read === undefined || field === null) {
      continue;
    }
    const others = fieldsNamedIn(read["value"] ?? "");
    named.push(field, ...others);
    if (block.label !== null || others.length > 0) {
      continue;
    }
    lines.push({ field, blockId: block.id, lead: read["lead"] ?? "", word });
  }
  return lines.filter(
    ({ field }) => named.filter((other) => other === field).length === 1,
  );
};
