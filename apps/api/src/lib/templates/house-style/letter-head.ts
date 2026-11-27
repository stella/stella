// Reads the head of a letter: the lines of the addressee, the date and the
// reference that stand in front of the salutation. A template for letters
// has cells for them; the rules that place the body know nothing of them.
// By rule, no language model; a letter the rules cannot read keeps its
// lines in the body.

import type { DocxBlock } from "@/api/lib/templates/house-style/folio-contract";

type LetterHead = {
  /** The lines of the addressee, in order: block ids. */
  addressee: string[];
  /** The line that states the date, or null. */
  date: string | null;
  /** The line that states a reference or file number, or null. */
  reference: string | null;
};

/** How far into a document a letter's salutation is looked for, in
 *  paragraphs with text. */
const HEAD_MAX = 30;
const HEAD_LINE_MAX = 70;
const ADDRESSEE_MAX = 7;

const SALUTATION =
  /^(?:vážen|dobrý den|milý|milá|dear\b|to whom it may concern|sehr geehrte|guten tag)/iu;
const REFERENCE =
  /^(?:č\.[  ]?j\.|čj\.|sp\.[  ]?zn\.|naše (?:zn|č)|vaše (?:zn|č)|our ref|your ref|ref(?:erence)?\.?[  ]*:|file (?:no|number)|unser zeichen|ihr zeichen|aktenzeichen|az\.)/iu;
const SUBJECT = /^(?:věc|re|subject|betreff|betr\.)[  ]*:/iu;
/** A day, a month and a year, in figures or with the month's name. */
const DATE =
  /\b\d{1,2}\.[  ]?\d{1,2}\.[  ]?\d{4}\b|\b\d{1,2}\.?[  ]+\p{L}{3,}[  ]+\d{4}\b|\b\p{L}{3,}[  ]+\d{1,2},[  ]+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/u;
/** A postal code as addresses write it: `110 00`, `66123`, `SW1A 1AA`. */
const POSTAL_CODE =
  /\b\d{3}[  ]\d{2}\b|\b\d{4,5}\b|\b[A-Z]{1,2}\d[A-Z\d]?[  ]?\d[A-Z]{2}\b/u;

/** A line may end in a period that closes a short form: `s.r.o.`, `Ltd.`,
 *  `a.s.`. A word in lower case with one period behind it ends a sentence
 *  (`dopis.`). */
const ENDS_IN_SHORT_FORM =
  /(?:^|[ \u00A0,])(?:\p{L}{1,3}\.(?:[ \u00A0]?\p{L}{1,3}\.)+|\p{Lu}[\p{L}]{0,5}\.)$/u;

const isHeadLine = (text: string): boolean =>
  text.length <= HEAD_LINE_MAX &&
  !/[;!?]$/u.test(text) &&
  (!text.endsWith(".") || ENDS_IN_SHORT_FORM.test(text));

/**
 * The head of a letter, read off the top-level paragraphs of a document.
 * Null for a document without a salutation near its start. The addressee is
 * the last run of short lines in front of the salutation that holds a
 * postal code and is no date, reference or subject line: two lines to seven.
 */
export const readLetterHead = (
  topLevel: readonly DocxBlock[],
): LetterHead | null => {
  const lines = topLevel
    .filter(({ kind, text }) => kind === "paragraph" && text.trim() !== "")
    .slice(0, HEAD_MAX);
  const end = lines.findIndex(({ text }) => SALUTATION.test(text.trim()));
  if (end === -1) {
    return null;
  }
  const head = lines.slice(0, end);
  const textOf = (block: DocxBlock): string => block.text.trim();
  const reference = head.find((block) => REFERENCE.test(textOf(block)));
  const date = head.find(
    (block) =>
      block !== reference &&
      !SUBJECT.test(textOf(block)) &&
      isHeadLine(textOf(block)) &&
      DATE.test(textOf(block)),
  );
  const plain = (block: DocxBlock): boolean =>
    block !== reference &&
    block !== date &&
    !SUBJECT.test(textOf(block)) &&
    !textOf(block).endsWith(":") &&
    isHeadLine(textOf(block));
  // Runs of plain lines that stand next to each other in the document.
  const runs: DocxBlock[][] = [];
  for (const block of head) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (!plain(block)) {
      runs.push([]);
    } else if (
      run === undefined ||
      // A blank line parts two blocks of lines: the sender's address from
      // the addressee's.
      (previous !== undefined &&
        topLevel.indexOf(block) - topLevel.indexOf(previous) > 1)
    ) {
      runs.push([block]);
    } else {
      run.push(block);
    }
  }
  const addressee = runs.findLast(
    (run) =>
      run.length >= 2 &&
      run.length <= ADDRESSEE_MAX &&
      run.some((block) => POSTAL_CODE.test(textOf(block))),
  );
  if (
    addressee === undefined &&
    date === undefined &&
    reference === undefined
  ) {
    return null;
  }
  return {
    addressee: addressee === undefined ? [] : addressee.map(({ id }) => id),
    date: date?.id ?? null,
    reference: reference?.id ?? null,
  };
};
