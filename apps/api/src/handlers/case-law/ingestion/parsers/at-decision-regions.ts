/**
 * The regions of an Austrian decision, read from what the court printed.
 *
 * RIS labels each section with a content type, but the label names where the
 * publisher filed the text, not what the court wrote there: the BVwG files
 * the docket line, the formula and the bench under `spruch`, a regional
 * administrative court or a tribunal files the whole decision under `text`,
 * and the VwGH files the bench recital under `betreff`. Findok labels
 * nothing. The court itself prints the same markers everywhere: the kind of
 * decision and the formula, a recital naming the authority and its bench
 * that ends in a colon (`zu Recht erkannt:`, `wie folgt entschieden:`), an
 * optional `Spruch` label, then `Begründung` or `Entscheidungsgründe`, and a
 * `Rechtsmittelbelehrung` and the place and date at the end.
 *
 * The reader sees the whole decision before it assigns a role and only moves
 * forward: head matter, operative part, reasons, closing, annex. A marker
 * that would move it back (a `Spruch` printed inside the reasons) leaves the
 * region as it is.
 */
import { panic } from "better-result";

import type { ParagraphRole } from "@stll/legal-ast/document-ast";
import { normalizeUnicode } from "@stll/text-normalize";

/**
 * Where the publisher filed a paragraph of the court's own text:
 * `operative` under the ruling (`spruch`), `reasons` under the reasons
 * (`begruendung`, `rechtlichebeurteilung`), `text` where the label says
 * nothing about the part (`text` in RIS, every paragraph in Findok).
 */
export type AtCourtTextSection = "operative" | "reasons" | "text";

/**
 * One printed line of the decision, in order. A heading's label moves the
 * reader; a publisher field (court, date, norms) is passed over and keeps
 * the role its label gives it; a paragraph break is spacing a recital runs
 * across.
 */
export type AtPrintedLine =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string; section: AtCourtTextSection }
  | { type: "field" }
  | { type: "break" };

type Region =
  "head" | "subject" | "operative" | "reasons" | "closing" | "annex";

/** Head matter in either of its forms comes first, then the parts in order. */
const REGION_RANK = {
  head: 0,
  subject: 0,
  operative: 1,
  reasons: 2,
  closing: 3,
  annex: 4,
} as const satisfies Record<Region, number>;

/** Printed alone, these name the decision or its formula. */
const HEAD_TITLES: ReadonlySet<string> = new Set([
  "bescheid",
  "beschluss",
  "erkenntnis",
  "im namen der republik",
  "urteil",
]);

/** The heading of an abridged ruling given orally first (BVwG, AsylGH). */
const ABRIDGED_RULING_RE = /^gekürzte ausfertigung\b/u;

/** `Betrifft:` opens the subject line a tribunal prints above its ruling. */
const SUBJECT_LABEL = "betrifft";

const OPERATIVE_LABEL = "spruch";

const REASONS_LABELS: ReadonlySet<string> = new Set([
  "begründung",
  "entscheidungsgründe",
  "gründe",
  "rechtliche beurteilung",
]);

const CLOSING_LABELS: ReadonlySet<string> = new Set([
  "belehrung",
  "rechtsmittelbelehrung",
  "rechtsmittelbelehrung und hinweise",
]);

/**
 * `Anhänge zu den Auflagen:` after the instructions on appeal: material the
 * ruling attaches, which is neither its reasons nor its closing. The label
 * stands alone on its line and ends in a colon (`Beilage: Erlagschein` names
 * an enclosure, not an annex), and only the closing leads there, so a
 * `Beilage` the ruling names never ends it.
 */
const ANNEX_LABEL_RE = /^(?:anhang|anhänge|beilage|beilagen)\b[^:]{0,60}:$/iu;

/**
 * The recital names the deciding authority before its verb: `Das
 * Landesverwaltungsgericht Kärnten erkennt`, `Der Oberste Gerichtshof hat`,
 * `Der Vergabekontrollsenat des Landes Wien hat`. A party (`Der
 * Beschwerdeführer hat durch …`) is not an authority, so it never opens one.
 */
const RECITAL_RE =
  /^(?:Das|Der|Die)\s+(?:[\p{L}.-]+\s+){0,6}?[\p{L}-]*(?:gerichtshof|gericht|senat|amt|behörde|kommission|kammer)(?:\s+[\p{L}.-]+){0,4}?\s+(?:hat|haben|erkennt|beschließt|entscheidet)\b/iu;

/**
 * The authority whose decision is under review, not the one deciding: `Die
 * belangte Behörde hat durch …`, `Das Erstgericht hat …`, `Das Rekursgericht
 * hat erwogen:`.
 */
const REVIEWED_AUTHORITY_RE = /^(?:Das|Der|Die)\s+(?:belangte\b|erst|rekurs)/iu;

/**
 * The recital names the bench: `durch die Richterin`, `durch den
 * Vorsitzenden`, `durch das Mitglied`, `als Einzelrichter`.
 */
const BENCH_RE =
  /\b(?:durch|als)\s+(?:[\p{L}.,*-]+\s+){0,8}?[\p{L}-]*(?:richter|vorsitzend|mitglied|präsident|hofr[aä]t|berichter)\p{L}*/iu;

/**
 * The words that announce the ruling and end the recital, wherever on the
 * line they fall: `zu Recht erkannt:`, `den Beschluss gefasst:`,
 * `entschieden (Bescheiderlassung durch Verkündung am 19.10.2004):`. A bare
 * `wie folgt:` is not among them: a ruling prints it (`wird wie folgt
 * abgeändert:`).
 */
const RULING_ANNOUNCED_RE =
  /(?:erkannt|entschieden|beschlossen|gefasst|zu\s+Recht|verfügt)\s*(?:\([^)]*\)\s*)?:/iu;

const ENDS_WITH_COLON_RE = /:\s*$/u;

/**
 * A recital line that ends its sentence: a word of at least three lowercase
 * letters and a full stop (`… entschieden.`), never an abbreviation (`Dr.`)
 * or a list number (`2.`) a recital wraps after.
 */
const ENDS_SENTENCE_RE = /\p{Ll}{3,}\.["“”»]?\s*$/u;

/** The most lines a recital runs over (the Umweltsenat lists every appellant). */
const MAX_RECITAL_LINES = 12;

/**
 * `Wien, am 2. Jänner 2026`, `Linz, den 18.02.2010.`: the place and date.
 * Only that line closes: a letter the reasons quote prints one too, and the
 * text after it is still the reasons. At the head it is the letterhead.
 */
const PLACE_DATE_RE =
  /^\p{Lu}[\p{L} .-]{1,40},\s*(?:am\s+|den\s+)?(?:\d{1,2}\.\s*\p{L}+\s+\d{4}|\d{1,2}\.\s*\d{1,2}\.\s*\d{4})\.?$/u;

/** `GZ 611.058/001-BKS/2003`, `W224 2231206-1/13E`: the docket repeated. */
const DOCKET_PREFIX_RE = /^(?:GZ|Zahl|Zl\.|Geschäftszahl)[:\s]+/iu;

/** What a repeated docket may print after the docket itself: `/13E`, `-22`. */
const MAX_DOCKET_SUFFIX_CHARS = 12;

/** A docket continues past its end only with a separator, never a digit. */
const DOCKET_CONTINUES_RE = /^[\p{L}\p{N}]/u;

const labelOf = (text: string): string =>
  normalizeUnicode(text, "NFC")
    .replaceAll(/\s+/gu, " ")
    .replace(/[\s:.!]+$/u, "")
    .trim()
    .toLocaleLowerCase("de");

const compact = (text: string): string =>
  text.replaceAll(/\s+/gu, "").toLocaleLowerCase("de");

/** Whether `text` is the deciding authority's recital of itself and its bench. */
export const isAtBenchRecital = (text: string): boolean =>
  RECITAL_RE.test(text) &&
  !REVIEWED_AUTHORITY_RE.test(text) &&
  (BENCH_RE.test(text) || RULING_ANNOUNCED_RE.test(text));

/**
 * Whether the recital ends on this line. Its first line may end it any way a
 * sentence ends; a line it wrapped onto only with the words that announce
 * the ruling, so a ruling printed after a recital that never ends is not
 * read into it.
 */
const endsRecital = (text: string, first: boolean): boolean =>
  RULING_ANNOUNCED_RE.test(text) ||
  (first && (ENDS_WITH_COLON_RE.test(text) || ENDS_SENTENCE_RE.test(text)));

const isMovingLabel = (label: string): boolean =>
  label === OPERATIVE_LABEL ||
  REASONS_LABELS.has(label) ||
  CLOSING_LABELS.has(label);

/**
 * The role of each printed line, in order; `undefined` for headings,
 * publisher fields and an annex. `dockets` are the case numbers the
 * publisher lists for the decision: a head line that repeats one is the
 * docket line, not the ruling.
 */
export const readAtDecisionRoles = (
  lines: readonly AtPrintedLine[],
  dockets: readonly string[],
): (ParagraphRole | undefined)[] => {
  const docketKeys = dockets.map(compact).filter((docket) => docket !== "");
  const labels = lines.map((line) =>
    line.type === "heading" || line.type === "paragraph"
      ? labelOf(line.text)
      : "",
  );
  // Instructions on appeal close the decision once, at its end. An earlier
  // `Rechtsmittelbelehrung` is the reasons quoting the decision under review.
  const closingAt = labels.findLastIndex((label) => CLOSING_LABELS.has(label));

  let region: Region = "head";
  /** A recital, or a `Spruch` label above it, announced the ruling. */
  let rulingAnnounced = false;
  /** The last line of a recital being read, if one is. */
  let recitalEnd: number | undefined;
  let lastSection: AtCourtTextSection | undefined;

  const advance = (next: Region): void => {
    if (REGION_RANK[next] > REGION_RANK[region]) {
      region = next;
    }
  };

  const roleOfRegion = (): ParagraphRole | undefined => {
    switch (region) {
      case "head":
      case "subject": {
        return "intro";
      }
      case "operative": {
        return "holding";
      }
      case "reasons": {
        return "argumentation";
      }
      case "closing": {
        return "closing";
      }
      case "annex": {
        return undefined;
      }
      default: {
        region satisfies never;
        return panic("Unhandled Austrian decision region");
      }
    }
  };

  const repeatsDocket = (text: string): boolean => {
    const printed = compact(text.replace(DOCKET_PREFIX_RE, ""));
    return docketKeys.some(
      (docket) =>
        printed.startsWith(docket) &&
        printed.length - docket.length <= MAX_DOCKET_SUFFIX_CHARS &&
        !DOCKET_CONTINUES_RE.test(printed.slice(docket.length)),
    );
  };

  /**
   * The last line of the recital opening at `start` (see `endsRecital`). A
   * recital that never ends before a label, a heading or a change of section
   * is its first line alone, so it cannot swallow the ruling after it.
   */
  const recitalEndFrom = (start: number): number => {
    const limit = Math.min(lines.length, start + MAX_RECITAL_LINES);
    const first = lines[start];
    const section = first?.type === "paragraph" ? first.section : undefined;
    for (let index = start; index < limit; index += 1) {
      const line = lines[index];
      if (line?.type === "break") {
        continue;
      }
      if (
        line?.type !== "paragraph" ||
        line.section !== section ||
        (index > start && isMovingLabel(labels[index] ?? ""))
      ) {
        return start;
      }
      if (endsRecital(line.text, index === start)) {
        return index;
      }
    }
    return start;
  };

  /** The role of a head line, if it is one. */
  const headRole = (
    index: number,
    text: string,
  ): "intro" | "case-number" | undefined => {
    const label = labels[index] ?? "";
    if (HEAD_TITLES.has(label) || ABRIDGED_RULING_RE.test(label)) {
      return "intro";
    }
    if (label === SUBJECT_LABEL) {
      region = "subject";
      return "intro";
    }
    if (PLACE_DATE_RE.test(text.trim())) {
      return "intro";
    }
    if (repeatsDocket(text)) {
      return "case-number";
    }
    if (isAtBenchRecital(text)) {
      rulingAnnounced = true;
      recitalEnd = recitalEndFrom(index);
      if (recitalEnd === index) {
        recitalEnd = undefined;
        region = "operative";
      }
      return "intro";
    }
    return undefined;
  };

  /** Where the court's text goes when nothing it printed says otherwise. */
  const enterSection = (section: AtCourtTextSection): void => {
    if (section === "reasons") {
      advance("reasons");
      return;
    }
    if (section === "text" && region === "operative") {
      // The ruling was printed under its own label; `text` follows it.
      advance("reasons");
    }
  };

  /** A label that moves the reader, printed as a heading or a paragraph. */
  const followLabel = (index: number): boolean => {
    const label = labels[index] ?? "";
    if (index === closingAt) {
      advance("closing");
      return true;
    }
    if (REASONS_LABELS.has(label)) {
      advance("reasons");
      return true;
    }
    if (label === OPERATIVE_LABEL) {
      // Above the recital (`BESCHEID` / `SPRUCH` / `Der … hat …
      // entschieden:`) the label titles the whole ruling, recital included;
      // after the subject line or the recital, the ruling starts here.
      if (region === "subject" || recitalEnd !== undefined) {
        recitalEnd = undefined;
        region = "operative";
      }
      rulingAnnounced = true;
      return true;
    }
    return false;
  };

  return lines.map((line, index) => {
    if (line.type === "field" || line.type === "break") {
      return undefined;
    }
    if (line.type === "heading") {
      followLabel(index);
      return undefined;
    }
    const { text, section } = line;
    if (section !== lastSection) {
      lastSection = section;
      enterSection(section);
    }
    if (recitalEnd !== undefined && !isMovingLabel(labels[index] ?? "")) {
      if (index >= recitalEnd) {
        recitalEnd = undefined;
        region = "operative";
      }
      return "intro";
    }
    if (followLabel(index)) {
      return roleOfRegion();
    }
    if (region === "closing" && ANNEX_LABEL_RE.test(text.trim())) {
      region = "annex";
    }
    if (region === "closing" || region === "annex") {
      return roleOfRegion();
    }
    if (
      (region === "operative" || region === "reasons") &&
      PLACE_DATE_RE.test(text.trim())
    ) {
      return "closing";
    }
    if (region === "head" || region === "subject") {
      const head = headRole(index, text);
      if (head !== undefined) {
        return head;
      }
      if (region === "subject") {
        return "intro";
      }
      // The first line that is no head matter opens the part its section
      // names; unlabelled text after a recital is the ruling it announced.
      region =
        section === "operative" || (section === "text" && rulingAnnounced)
          ? "operative"
          : "reasons";
    }
    return roleOfRegion();
  });
};
