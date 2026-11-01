/**
 * The regions of an Austrian decision, read from what the court printed.
 *
 * RIS labels each section with a content type, but the label names where the
 * publisher filed the text, not what the court wrote there: the BVwG files
 * the docket line, the formula and the bench under `spruch`, a regional
 * administrative court or a tribunal files the whole decision under `text`,
 * and the VwGH files the bench recital under `betreff`. Findok labels
 * nothing. The court itself prints the same markers everywhere: the kind of
 * decision and the formula, a recital naming the authority and the bench
 * that ends in a colon (`zu Recht erkannt:`, `wie folgt entschieden:`), an
 * optional `Spruch` label, then `Begründung` or `Entscheidungsgründe`, and a
 * `Rechtsmittelbelehrung` and the place and date at the end.
 *
 * The reader walks the decision once and only moves forward: head matter,
 * operative part, reasons, closing. A marker that would move it back (a
 * `Spruch` printed inside the reasons) leaves the region as it is.
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

type Region =
  | "head"
  | "subject"
  | "recital"
  | "operative"
  | "reasons"
  | "closing"
  | "annex";

/** Head matter in any of its forms comes first, then the parts in order. */
const REGION_RANK = {
  head: 0,
  subject: 0,
  recital: 0,
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
 * ruling attaches, which is neither its reasons nor its closing. Only the
 * closing leads there, so a `Beilage` the ruling names never ends it.
 */
const ANNEX_LABEL_RE = /^(?:anhang|anhänge|beilage|beilagen)\b/u;

/** A label is a short line; prose that starts with `Beilage` is not one. */
const MAX_LABEL_CHARS = 60;

/**
 * The recital names the deciding authority before its verb: `Das
 * Landesverwaltungsgericht Kärnten erkennt`, `Der Oberste Gerichtshof hat`,
 * `Der Vergabekontrollsenat des Landes Wien hat`. A party (`Der
 * Beschwerdeführer hat durch …`) is not an authority, so it never opens one.
 */
const RECITAL_RE =
  /^(?:Das|Der|Die)\s+(?:[\p{L}.-]+\s+){0,6}?[\p{L}-]*(?:gerichtshof|gericht|senat|amt|behörde|kommission|kammer)(?:\s+[\p{L}.-]+){0,4}?\s+(?:hat|haben|erkennt|beschließt|entscheidet)\b/iu;

const DURCH_RE = /\bdurch\b/u;

const ENDS_WITH_COLON_RE = /:\s*$/u;

/**
 * `Wien, am 2. Jänner 2026`, `Linz, 18.02.2010`: the place and date. Only
 * that line closes: a letter the reasons quote prints one too, and the text
 * after it is still the reasons.
 */
const PLACE_DATE_RE =
  /^\p{Lu}[\p{L} .-]{1,40},\s*(?:am\s+)?(?:\d{1,2}\.\s*\p{L}+\s+\d{4}|\d{1,2}\.\s*\d{1,2}\.\s*\d{4})$/u;

/** `GZ 611.058/001-BKS/2003`, `W224 2231206-1/13E`: the docket repeated. */
const DOCKET_PREFIX_RE = /^(?:GZ|Zahl|Zl\.)[:\s]+/iu;

/** What a repeated docket may print after the docket itself: `/13E`, `-22`. */
const MAX_DOCKET_SUFFIX_CHARS = 12;

const labelOf = (text: string): string =>
  normalizeUnicode(text, "NFC")
    .replaceAll(/\s+/gu, " ")
    .replace(/[\s:.!]+$/u, "")
    .trim()
    .toLocaleLowerCase("de");

const compact = (text: string): string =>
  text.replaceAll(/\s+/gu, "").toLocaleLowerCase("de");

export const isAtBenchRecital = (text: string): boolean =>
  RECITAL_RE.test(text) &&
  (DURCH_RE.test(text) || ENDS_WITH_COLON_RE.test(text));

export type AtDecisionRegions = {
  /** A heading printed in the decision: only its label moves the region. */
  heading: (text: string) => void;
  /** The role of a paragraph of the court's own text; none in an annex. */
  paragraph: (
    text: string,
    section: AtCourtTextSection,
  ) => ParagraphRole | undefined;
};

/**
 * Read the regions of one decision, paragraph by paragraph in printed order.
 * `dockets` are the case numbers the publisher lists for it; a head line
 * that repeats one is the docket line, not the ruling.
 */
export const readAtDecisionRegions = (
  dockets: readonly string[],
): AtDecisionRegions => {
  const docketKeys = dockets.map(compact).filter((docket) => docket !== "");
  let region: Region = "head";
  /** A recital, or a `Spruch` label above it, announced the ruling. */
  let rulingAnnounced = false;

  const repeatsDocket = (text: string): boolean => {
    const printed = compact(text.replace(DOCKET_PREFIX_RE, ""));
    return docketKeys.some(
      (docket) =>
        printed.startsWith(docket) &&
        printed.length - docket.length <= MAX_DOCKET_SUFFIX_CHARS,
    );
  };

  const beforeOperative = (): boolean => REGION_RANK[region] === 0;

  /** Move on to a later region; never back to an earlier one. */
  const advance = (next: Region): void => {
    if (REGION_RANK[next] > REGION_RANK[region]) {
      region = next;
    }
  };

  const roleOfRegion = (): ParagraphRole | undefined => {
    switch (region) {
      case "head":
      case "subject":
      case "recital": {
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

  /** A label that moves the region, for paragraphs and headings alike. */
  const followLabel = (label: string): boolean => {
    if (CLOSING_LABELS.has(label)) {
      advance("closing");
      return true;
    }
    if (REASONS_LABELS.has(label)) {
      advance("reasons");
      return true;
    }
    return false;
  };

  /** The head line `text` is, if it is one. */
  const headLine = (text: string): "intro" | "case-number" | undefined => {
    const label = labelOf(text);
    if (HEAD_TITLES.has(label) || ABRIDGED_RULING_RE.test(label)) {
      return "intro";
    }
    if (label === SUBJECT_LABEL) {
      region = "subject";
      return "intro";
    }
    if (repeatsDocket(text)) {
      return "case-number";
    }
    if (isAtBenchRecital(text)) {
      rulingAnnounced = true;
      region = ENDS_WITH_COLON_RE.test(text) ? "operative" : "recital";
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
    if (beforeOperative()) {
      return;
    }
    if (section === "text" && region === "operative") {
      // The ruling was printed under its own label; `text` follows it.
      advance("reasons");
    }
  };

  let lastSection: AtCourtTextSection | undefined;

  return {
    heading: (text) => {
      followLabel(labelOf(text));
    },
    paragraph: (text, section) => {
      if (section !== lastSection) {
        lastSection = section;
        enterSection(section);
      }
      const label = labelOf(text);
      if (followLabel(label)) {
        return roleOfRegion();
      }
      if (label === OPERATIVE_LABEL) {
        // Above the recital (`BESCHEID` / `SPRUCH` / `Der … hat …
        // entschieden:`) the label titles the whole ruling, recital included;
        // after it, the ruling starts here.
        if (region === "recital" || region === "subject") {
          region = "operative";
        }
        rulingAnnounced = true;
        return roleOfRegion();
      }
      if (
        region === "closing" &&
        label.length <= MAX_LABEL_CHARS &&
        ANNEX_LABEL_RE.test(label)
      ) {
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
      if (region === "recital") {
        if (ENDS_WITH_COLON_RE.test(text)) {
          region = "operative";
        }
        return "intro";
      }
      if (region === "head" || region === "subject") {
        const head = headLine(text);
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
    },
  };
};
