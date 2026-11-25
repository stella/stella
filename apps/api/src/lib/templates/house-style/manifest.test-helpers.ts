// Builds block manifests for the tests of this directory from terse specs.
// All text here is invented.

import { panic } from "better-result";

import type {
  DocxBlock,
  DocxBlockManifest,
} from "@/api/lib/templates/house-style/folio-contract";
import type { LabelIndex } from "@/api/lib/templates/house-style/label-index";

type BlockDetail = {
  text: string;
  /** Rendered automatic label; the block is then a list item. */
  label?: string;
  /** List the automatic label belongs to. */
  numId?: number;
  styleName?: string;
  outlineLevel?: number;
};

/** A plain paragraph by its text, or a paragraph with its details. */
type BlockSpec = string | BlockDetail;

/** An auto-numbered paragraph. */
export const numbered = (
  label: string,
  text: string,
  numId = 1,
): BlockDetail => ({
  text,
  label,
  numId,
});

export const heading = (text: string): BlockDetail => ({
  text,
  styleName: "heading 1",
  outlineLevel: 0,
});

export const manifestOf = (specs: readonly BlockSpec[]): DocxBlockManifest => ({
  sha256: "0".repeat(64),
  blocks: specs.map((spec, index): DocxBlock => {
    const detail: BlockDetail =
      typeof spec === "string" ? { text: spec } : spec;
    const {
      text,
      label = null,
      numId = 1,
      styleName = null,
      outlineLevel = null,
    } = detail;
    return {
      id: `p${String(index)}`,
      index,
      kind: "paragraph",
      text,
      label,
      numbering:
        label === null ? null : { numId, ilvl: 0, abstractNumId: numId },
      styleId: styleName === null ? null : styleName.replaceAll(" ", ""),
      styleName,
      outlineLevel,
      sectionIndex: 0,
      hash: `h${String(index)}`,
    };
  }),
  footnotes: [],
  endnotes: [],
  comments: 0,
  trackedChanges: 0,
  warnings: [],
});

/** The id of the first block whose text starts with `start`. */
export const blockIdOf = (
  { blocks }: DocxBlockManifest,
  start: string,
): string => {
  const block = blocks.find(({ text }) => text.startsWith(start));
  return block?.id ?? panic(`No block starts with ${JSON.stringify(start)}`);
};

/** A readable name for an indexed block: `XI`, `XI/2`, `XI/2/d`, `XI/2/d/ii`,
 *  `annex 1`. Tests compare these instead of block ids. */
export const provisionKey = (index: LabelIndex, blockId: string): string => {
  const entry = index.entryByBlockId.get(blockId);
  if (entry === undefined) {
    return `unindexed ${blockId}`;
  }
  switch (entry.level) {
    case "article":
      return entry.shape.core;
    case "clause": {
      const article = index.entryByBlockId.get(entry.articleBlockId ?? "");
      const head = article?.shape.core ?? String(entry.articleOrdinal ?? "-");
      return `${head}/${entry.clausePath.join(".")}`;
    }
    case "letter":
    case "roman":
      return entry.parentBlockId === null
        ? `-/${entry.core}`
        : `${provisionKey(index, entry.parentBlockId)}/${entry.core}`;
    case "annex":
      return `${entry.listed ? "listed annex" : "annex"} ${entry.core}`;
    case "recital":
      return `recital ${entry.core}`;
    default: {
      entry.level satisfies never;
      return panic("Unhandled level");
    }
  }
};

const ROMANS = [
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
  "XI",
  "XII",
  "XIII",
  "XIV",
] as const;

const CZECH_TITLES = [
  "Úvodní ustanovení",
  "Předmět plnění",
  "Místo a doba plnění",
  "Cena a platební podmínky",
  "Práva a povinnosti stran",
  "Součinnost objednatele",
  "Záruka za jakost",
  "Ochrana důvěrných informací",
  "Licenční ujednání",
  "Pojištění",
  "Smluvní pokuty",
  "Ukončení smlouvy",
  "Vyšší moc",
  "Bezpečnost práce a ochrana zdraví",
] as const;

/**
 * A Czech supply contract the way they are commonly typed: `Článek I.` to
 * `Článek XIV.` as text, paragraphs and letters as automatic lists that
 * restart in every article. Article I has its title in the next paragraph.
 * `citing` becomes the text of article V paragraph 2.
 */
export const czechContract = (citing: string): DocxBlockManifest => {
  const specs: BlockSpec[] = [
    "SMLOUVA O DODÁVCE",
    "Dodavatel: Vzorová dodavatelská s.r.o., se sídlem Dlouhá 1, Praha, IČO: 00000001",
    "(dále jen „dodavatel“)",
    "a",
    "Objednatel: Vzorový odběratel a.s., se sídlem Krátká 2, Brno, IČO: 00000002",
    "(dále jen „objednatel“)",
    "uzavírají tuto smlouvu:",
  ];
  for (const [position, roman] of ROMANS.entries()) {
    const title = CZECH_TITLES[position] ?? "";
    const list = 10 + position;
    if (roman === "I") {
      specs.push(`Článek ${roman}.`, title);
    } else {
      specs.push(`Článek ${roman}.\n${title}`);
    }
    specs.push(numbered("1.", `První ujednání, oddíl ${roman}.`, list));
    specs.push(
      numbered(
        "2.",
        roman === "V" ? citing : `Druhé ujednání, oddíl ${roman}:`,
        list,
      ),
    );
    if (roman === "II" || roman === "XI") {
      specs.push(
        numbered("a)", "první případ;", 100 + position),
        numbered("b)", "druhý případ;", 100 + position),
        numbered("c)", "třetí případ;", 100 + position),
        numbered("d)", "čtvrtý případ, a to:", 100 + position),
        numbered("(i)", "první podbod,", 200 + position),
        numbered("(ii)", "druhý podbod;", 200 + position),
        numbered("e)", "pátý případ.", 100 + position),
      );
    }
    specs.push(numbered("3.", `Třetí ujednání, oddíl ${roman}.`, list));
  }
  specs.push(
    numbered("4.", "Nedílnou součástí této smlouvy jsou tyto přílohy:", 23),
    "Příloha č. 1 – Specifikace",
    "Příloha č. 2 – Ceník",
    "V Praze dne ……………",
    "Za dodavatele",
    "Příloha č. 1",
    "Specifikace",
    numbered("1.", "Obsah specifikace.", 300),
    numbered("2.", "Rozsah specifikace.", 300),
    "Příloha č. 2\nCeník",
    "Ceny jsou uvedeny bez daně.",
  );
  return manifestOf(specs);
};

/**
 * A Czech contract numbered by a template's own scheme: `Čl. 1` to `Čl. 6`
 * and `1.1.` to `6.3.`, all automatic. `citing` is paragraph 2.2.
 */
export const czechDecimalContract = (citing: string): DocxBlockManifest => {
  const specs: BlockSpec[] = ["RÁMCOVÁ DOHODA", "uzavřená mezi stranami:"];
  for (let article = 1; article <= 6; article += 1) {
    specs.push(numbered(`Čl. ${String(article)}`, `Nadpis ${String(article)}`));
    for (let clause = 1; clause <= 3; clause += 1) {
      const label = `${String(article)}.${String(clause)}.`;
      specs.push(
        numbered(
          label,
          article === 2 && clause === 2 ? citing : `Znění ${label}`,
        ),
      );
    }
  }
  return manifestOf(specs);
};

/**
 * An English agreement in the dotted scheme: `1.` to `6.` as headings,
 * `1.1` to `6.3` as clauses, `(a)` and `(i)` below clause 2.3, recitals
 * `(A)` and `(B)` typed in front, `Annex 1` and `Annex 2` behind the
 * signatures. `citing` is clause 4.2.
 */
export const englishAgreement = (citing: string): DocxBlockManifest => {
  const specs: BlockSpec[] = [
    "SERVICES AGREEMENT",
    "Example Supplier Limited, a company with its registered office at 1 Long Street (the “Supplier”)",
    "Example Customer plc, a company with its registered office at 2 Short Street (the “Customer”)",
    "(A) The Supplier provides hosting services.",
    "(B) The Customer wishes to receive them.",
  ];
  const titles = [
    "Definitions",
    "Services",
    "Charges",
    "Liability",
    "Term",
    "General",
  ];
  for (const [position, title] of titles.entries()) {
    const article = position + 1;
    specs.push({ ...heading(title), label: `${String(article)}.` });
    for (let clause = 1; clause <= 3; clause += 1) {
      const label = `${String(article)}.${String(clause)}`;
      specs.push(
        numbered(
          label,
          article === 4 && clause === 2 ? citing : `Wording ${label}:`,
        ),
      );
      if (article === 2 && clause === 3) {
        specs.push(
          numbered("(a)", "first limb;", 2),
          numbered("(b)", "second limb, being:", 2),
          numbered("(i)", "first sub-limb; and", 3),
          numbered("(ii)", "second sub-limb.", 3),
        );
      }
    }
  }
  specs.push(
    "Signed by the parties on the date stated above.",
    "Annex 1",
    "Service Levels",
    numbered("1.", "Availability target.", 4),
    "Annex 2\nCharges Table",
  );
  return manifestOf(specs);
};

/**
 * A German contract: `§ 1` to `§ 6` typed as headings, `(1)` to `(3)` as
 * automatic paragraphs, letters under § 3 (1), `Anlage 1` at the end.
 * `citing` is § 4 (2).
 */
export const germanContract = (citing: string): DocxBlockManifest => {
  const specs: BlockSpec[] = [
    "DIENSTLEISTUNGSVERTRAG",
    "zwischen der Muster Lieferant GmbH mit Sitz in Musterstadt (nachfolgend „Auftragnehmer“)",
    "und der Muster Kunde AG mit Sitz in Beispielstadt (nachfolgend „Auftraggeber“)",
  ];
  const titles = [
    "Vertragsgegenstand",
    "Leistungen",
    "Vergütung",
    "Haftung",
    "Laufzeit",
    "Schlussbestimmungen",
  ];
  for (const [position, title] of titles.entries()) {
    const section = position + 1;
    specs.push(`§ ${String(section)} ${title}`);
    for (let clause = 1; clause <= 3; clause += 1) {
      specs.push(
        numbered(
          `(${String(clause)})`,
          section === 4 && clause === 2
            ? citing
            : `Regelung ${String(section)}-${String(clause)}:`,
          10 + section,
        ),
      );
      if (section === 3 && clause === 1) {
        specs.push(
          numbered("a)", "erster Fall;", 30),
          numbered("b)", "zweiter Fall.", 30),
        );
      }
    }
  }
  specs.push("Ort, Datum: ____________", "Anlage 1\nLeistungsbeschreibung");
  return manifestOf(specs);
};
