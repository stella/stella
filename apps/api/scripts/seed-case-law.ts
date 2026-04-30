/**
 * Seed the database with sample decisions for local testing of the
 * Case Law feature.
 *
 * Mostly based on real decisions from rozhodnuti.nsoud.cz with section text
 * trimmed for brevity. Includes citation cross-references between seeded
 * decisions plus a small English injunction sample for global search testing.
 *
 * Prerequisites:
 *   Run seed-test-user.ts first to create the test organization.
 *
 * Usage:
 *   bun apps/api/scripts/seed-case-law.ts
 */

import { and, eq, sql } from "drizzle-orm";

import { createScopedDb } from "@/api/db";
import { db } from "@/api/db/root";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { indexDecision } from "@/api/handlers/case-law/search-index";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

import { DEFAULT_ORG_ID, DEFAULT_USER_ID, seedId } from "./seed-utils";

// ─── Deterministic ID helpers ──────────────────────────────

const SOURCE_ID = seedId("case-law-source-cz-ns");

const decId = (caseNumber: string) => seedId(`case-law-dec-${caseNumber}`);
const citId = (label: string) => seedId(`case-law-cit-${label}`);

// ─── Seed data ─────────────────────────────────────────────

type SeedDecision = {
  caseNumber: string;
  ecli: string | null;
  court: string;
  country: string;
  language: string;
  decisionDate: string;
  decisionType: string;
  sections: DecisionSection[];
  sourceUrl: string;
  metadata: Record<string, unknown>;
  sourceHash: string;
};

// Sorted by decisionDate ascending. Cross-reference citations use array
// indices; the `crossRef` helper below enforces at the type level that
// the citing decision's index is strictly greater than the cited one,
// making temporally impossible citations a compile error.
const decisions = [
  // 0 — 2005-04-28
  {
    caseNumber: "11 Tcu 21/2005",
    ecli: "ECLI:CZ:NS:2005:11.TCU.21.2005.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2005-04-28",
    decisionType: "usnesení",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "11 Tcu 21/2005\n\nUSNESENÍ\n\nNejvyšší soud České republiky projednal dne 28. dubna 2005 v neveřejném zasedání návrh Ministerstva spravedlnosti České republiky na zápis odsouzení cizozemským soudem do evidence Rejstříku trestů.",
      },
      {
        index: 1,
        type: "argumentation",
        title: "Odůvodnění:",
        text: "Rozsudkem Soudu první instance v Créteil, Francouzská republika, ze dne 13. 11. 2003 byla obžalovaná uznána vinnou trestnými činy nedovolené přepravy omamných látek a účasti na zločinném spolčení.",
      },
    ],
    sourceUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/006908449700C971C1257A4E00650ED7",
    metadata: {
      keywords: null,
      statutes: null,
      category: null,
    },
    sourceHash:
      "5cba16f6048693c4f9b53e05ae4a58f1c485cc41baa14ae16b88b8aac096be6e",
  },
  // 1 — 2006-09-13
  {
    caseNumber: "29 Odo 975/2006",
    ecli: "ECLI:CZ:NS:2006:29.ODO.975.2006.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2006-09-13",
    decisionType: "usnesení",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "29 Odo 975/2006\n\nUSNESENÍ\n\nNejvyšší soud České republiky rozhodl v senátě složeném z předsedkyně JUDr. Ivany Štenglové a soudců Mgr. Tomáše Brauna a JUDr. Hany Gajdziokové.",
      },
      {
        index: 1,
        type: "argumentation",
        title: "Odůvodnění:",
        text: "Vrchní soud v Praze potvrdil usnesení, jímž Městský soud v Praze odmítl pro opožděnost odvolání žalovaného proti rozsudku pro uznání a rozhodl o náhradě nákladů odvolacího řízení.",
      },
    ],
    sourceUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/00038EC6F9D76E31C1257A4E0065A3CE",
    metadata: {
      keywords: null,
      statutes: [
        "§ 243b odst. 5 předpisu č. 99/1963Sb.",
        "§ 218 odst. 5 písm. c) předpisu č. 99/1963Sb.",
      ],
      category: "E",
    },
    sourceHash:
      "a9e06d637c22e55cb0748c93312dfda37cce28a7a03d95055eac57a74da24cbb",
  },
  // 2 — 2007-06-27
  {
    caseNumber: "29 Odo 756/2005",
    ecli: "ECLI:CZ:NS:2007:29.ODO.756.2005.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2007-06-27",
    decisionType: "usnesení",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "29 Odo 756/2005\n\nUSNESENÍ\n\nNejvyšší soud České republiky v senátě složeném z předsedy JUDr. Zdeňka Krčmáře a soudkyň JUDr. Ivany Štenglové a JUDr. Hany Gajdziokové.",
      },
      {
        index: 1,
        type: "argumentation",
        title: "Odůvodnění:",
        text: "Městský soud v Praze rozsudkem zamítl žalobu, kterou se žalobce domáhal zrušení Bytového družstva B. Soud prvního stupně dospěl k závěru, že podmínky pro zrušení družstva nebyly splněny.",
      },
    ],
    sourceUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/00080583AEF89D01C1257A4E00670A19",
    metadata: {
      judge: "JUDr. Zdeněk Krčmář",
      keywords: null,
      statutes: null,
      category: "E",
    },
    sourceHash:
      "96d64d4cc931481de622fb030b9d379dc604fcb7ef55f9bb56a9d2630dfc0528",
  },
  // 3 — 2010-10-12
  {
    caseNumber: "22 Cdo 1772/2010",
    ecli: "ECLI:CZ:NS:2010:22.CDO.1772.2010.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2010-10-12",
    decisionType: "rozsudek",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "22 Cdo 1772/2010\n\nROZSUDEK\n\nNejvyšší soud České republiky rozhodl v senátě složeném z předsedy JUDr. Jiřího Spáčila, CSc., a soudců JUDr. Františka Baláka a Mgr. Michala Králíka, Ph.D.",
      },
      {
        index: 1,
        type: "argumentation",
        title: "Odůvodnění:",
        text: "Městský soud v Brně rozsudkem ze dne 22. července 2008 rozhodl o vypořádání bezpodílového spoluvlastnictví bývalých manželů. Věc se týkala rozdělení movitých věcí a finančních prostředků.",
      },
    ],
    sourceUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/0001F08FA544A52DC1257A4E00654DE5",
    metadata: {
      judge: "JUDr. Jiří Spáčil, CSc.",
      keywords: ["Bezpodílové spoluvlastnictví manželů"],
      statutes: ["§ 149 obč. zák."],
      category: "C",
    },
    sourceHash:
      "5f0b05f75272af442abf1d869ef40395b105f2929ecb24b8eaa3935bae22a349",
  },
  // 4 — 2012-07-11
  {
    caseNumber: "30 Cdo 3543/2011",
    ecli: "ECLI:CZ:NS:2012:30.CDO.3543.2011.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2012-07-11",
    decisionType: "rozsudek",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "30 Cdo 3543/2011\n\nČESKÁ REPUBLIKA\nROZSUDEK JMÉNEM REPUBLIKY\n\nNejvyšší soud České republiky rozhodl v senátě složeném z předsedy JUDr. Františka Ištvánka a soudců JUDr. Pavla Simona a JUDr. Pavla Pavlíka.",
      },
      {
        index: 1,
        type: "argumentation",
        title: "Odůvodnění:",
        text: "Žalobce uplatnil nároky na odškodnění nemajetkové újmy vzniklé nepřiměřenou délkou řízení vedeného u Okresního soudu Brno-venkov a na náhradu škody spočívající v nákladech vynaložených na právní zastoupení.",
      },
    ],
    sourceUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/0007425783B40419C1257A4E0068EE6A",
    metadata: {
      judge: "JUDr. František Ištvánek",
      keywords: [
        "Odpovědnost státu za škodu",
        "Průtahy v řízení",
        "Zadostiučinění (satisfakce)",
      ],
      statutes: [
        "§ 237 odst. 1 písm. c) o. s. ř.",
        "§ 31a předpisu č. 82/1998Sb.",
      ],
      category: "C",
    },
    sourceHash:
      "e4fdfed2f36e0db2fae267e0561b3b3d6838c7328d452f23f382d8316de0a703",
  },
  // 5 — 2013-10-31
  {
    caseNumber: "29 ICdo 37/2013",
    ecli: "ECLI:CZ:NS:2013:29.ICDO.37.2013.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2013-10-31",
    decisionType: "usnesení",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "29 ICdo 37/2013\n\nUSNESENÍ\n\nNejvyšší soud České republiky rozhodl v senátě složeném z předsedy JUDr. Petra Gemmela a soudců JUDr. Zdeňka Krčmáře a Mgr. Milana Poláška.",
      },
      {
        index: 1,
        type: "argumentation",
        title: "Odůvodnění:",
        text: "Vrchní soud v Praze usnesením ze dne 27. března 2013 rozhodl o tom, že k projednání a rozhodnutí věci vedené u Městského soudu v Praze jsou v prvním stupni věcně příslušné okresní soudy.",
      },
    ],
    sourceUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/00023AC42E1B0AE6C1257C3C003ADD1B",
    metadata: {
      judge: "JUDr. Petr Gemmel",
      keywords: null,
      statutes: [
        "§ 236 odst. 1 o. s. ř.",
        "§ 104a odst. 2 o. s. ř.",
        "§ 243b o. s. ř.",
      ],
      category: "E",
    },
    sourceHash:
      "c1c1533ffac3112f73c338aa91c71124be7ad8979fe31ffbfb4787a5f433dc8d",
  },
  // 6 — 2015-12-15
  {
    caseNumber: "23 Cdo 3470/2015",
    ecli: "ECLI:CZ:NS:2015:23.CDO.3470.2015.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2015-12-15",
    decisionType: "usnesení",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "23 Cdo 3470/2015\n\nUSNESENÍ\n\nNejvyšší soud České republiky rozhodl v senátě složeném z předsedy JUDr. Pavla Horáka, Ph.D., a soudců JUDr. Zdeňka Dese a Mgr. Miroslava Hromady, Ph.D.",
      },
      {
        index: 1,
        type: "argumentation",
        title: "Odůvodnění:",
        text: "(dle § 243f odst. 3 o. s. ř.)\n\nKrajský soud v Brně rozsudkem, v pořadí druhým, ze dne 1. února 2012, č. j. 25 Cm 237/2005-197, uložil žalované povinnost zaplatit žalobkyni 357.967,- Kč s příslušenstvím.",
      },
    ],
    sourceUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/00007CCB5DBCB0F0C1257F6F00369EAE",
    metadata: {
      judge: "JUDr. Pavel Horák, Ph.D.",
      keywords: ["Přípustnost dovolání", "Postoupení pohledávky"],
      statutes: ["§ 237 o. s. ř.", "§ 529 odst. 2 obč. zák."],
      category: "E",
    },
    sourceHash:
      "193bddb88707174644a32b0cdb7fd72e2fd14672e2bf6b1268aed29a8476cda2",
  },
  // 7 — 2016-01-13
  {
    caseNumber: "28 Cdo 3959/2014",
    ecli: "ECLI:CZ:NS:2016:28.CDO.3959.2014.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2016-01-13",
    decisionType: "usnesení",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "28 Cdo 3959/2014\n\nUSNESENÍ\n\nNejvyšší soud České republiky rozhodl v senátě složeném z předsedkyně senátu JUDr. Olgy Puškinové a soudců JUDr. Jana Eliáše, Ph.D., a Mgr. Petra Krause.",
      },
    ],
    sourceUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/00036A17CD475891C1257F850030A984",
    metadata: {
      keywords: ["Dovolání", "Přípustnost dovolání", "Vady podání"],
      statutes: [
        "§ 243f odst. 3 o. s. ř.",
        "§ 237 o. s. ř.",
        "§ 243c odst. 1,3 o. s. ř.",
      ],
      category: "E",
    },
    sourceHash:
      "b7d80d7adbfa45f00edec4e7c82c401603f64248a630cc15692adebe5c81c388",
  },
  // 8 — 2019-10-01
  {
    caseNumber: "21 Cdo 4509/2018",
    ecli: "ECLI:CZ:NS:2019:21.CDO.4509.2018.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2019-10-01",
    decisionType: "rozsudek",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "21 Cdo 4509/2018\n\nČESKÁ REPUBLIKA\n\nROZSUDEK JMÉNEM REPUBLIKY\n\nNejvyšší soud České republiky rozhodl v senátě složeném z předsedy senátu JUDr. Jiřího Doležílka a soudců JUDr. Pavla Malého a JUDr. Mojmíra Putny.",
      },
      {
        index: 1,
        type: "argumentation",
        title: "Odůvodnění:",
        text: "Žalobce se domáhal zaplacení 9 595 Kč s úrokem z prodlení představující dlužnou mzdu a peněžitého plnění z konkurenční doložky. Řešena otázka platnosti konkurenční doložky a přiměřenosti protiplnění.",
      },
    ],
    sourceUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/00037BD1854B2819C12584DF001EFCD1",
    metadata: {
      judge: "JUDr. Jiří Doležílek",
      keywords: [
        "Konkurenční doložka",
        "Náhrada škody zaměstnavatelem",
        "Neplatnost právního úkonu",
      ],
      statutes: [
        "§ 310 odst. 1 předpisu č. 262/2006Sb.",
        "§ 310 odst. 2 předpisu č. 262/2006Sb.",
      ],
      category: "C",
    },
    sourceHash:
      "eb7b358a643cf991f3cccd196efd5f91c2db958a6aa70f71f4f56c11cbbc3bbe",
  },
  // 9 — 2024-11-12
  {
    caseNumber: "23 Nd 480/2024",
    ecli: "ECLI:CZ:NS:2024:23.ND.480.2024.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2024-11-12",
    decisionType: "usnesení",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "23 Nd 480/2024\n\nUSNESENÍ\n\nNejvyšší soud rozhodl v senátě složeném z předsedy JUDr. Bohumila Dvořáka, Ph.D., a soudců JUDr. Pavla Horáka, Ph.D., a JUDr. Pavla Tůmy, Ph.D., v exekuční věci oprávněné Bohemia Faktoring, a. s.",
      },
      {
        index: 1,
        type: "argumentation",
        title: "Odůvodnění:",
        text: "Okresní soud v Ostravě usnesením ze dne 15. 10. 2024 vyslovil svou místní nepříslušnost. Nejvyšší soud určil, který soud věc projedná a rozhodne podle § 11 odst. 3 o. s. ř.",
      },
    ],
    sourceUrl:
      "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/00024C464B55E75DC1258BF70052AA95",
    metadata: {
      judge: "JUDr. Bohumil Dvořák, Ph.D.",
      keywords: ["Příslušnost soudu místní"],
      statutes: ["§ 11 odst. 3 o. s. ř."],
      category: "E",
    },
    sourceHash:
      "fa31e910c538202f39507e1ebece00824de72dcd80732c8a40498e4abd265649",
  },
  // 10 — 2025-02-20
  {
    caseNumber: "Smith v. Jones 2024",
    ecli: null,
    court: "High Court of Justice",
    country: "GBR",
    language: "en",
    decisionDate: "2025-02-20",
    decisionType: "judgment",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "Smith v. Jones 2024\n\nJUDGMENT\n\nThe High Court considered contractual interpretation, without prejudice communications, and interim injunctive relief.",
      },
      {
        index: 1,
        type: "argumentation",
        title: "Reasons",
        text: "The claimant sought interim injunctive relief to preserve confidential source materials pending trial. The court held that damages would not be an adequate remedy and granted a limited injunction.",
      },
    ],
    sourceUrl: "https://example.test/case-law/smith-v-jones-2024",
    metadata: {
      keywords: ["interim injunction", "confidentiality", "contract"],
      statutes: null,
      category: "dev-sample",
    },
    sourceHash:
      "0f5a08f15bd90a404d265d65df3bbeb3f4f81be0cf3774c2a839bfcdce4f8a14",
  },
] as const satisfies readonly SeedDecision[];

// ─── Type-safe cross-references ────────────────────────────

type DecisionIdx = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** All indices strictly less than N (decisions is date-sorted, so lower index = earlier date). */
type LessThan<
  N extends number,
  Acc extends never[] = [],
> = Acc["length"] extends N
  ? never
  : Acc["length"] | LessThan<N, [...Acc, never]>;

type CitationPolarity =
  | "positive"
  | "supportive"
  | "neutral"
  | "negative"
  | null;

type SeedCitation = {
  citingCaseNumber: string;
  citedCaseNumber: string | null;
  citationText: string;
  sectionIndex: number | null;
  polarity: CitationPolarity;
};

/**
 * Build a cross-reference citation between two seeded decisions.
 * Temporal ordering is enforced at the type level: `citingIdx` must be
 * strictly greater than `citedIdx` in the date-sorted `decisions` array.
 */
const crossRef = <Citing extends Exclude<DecisionIdx, 0>>(
  citingIdx: Citing,
  citedIdx: LessThan<Citing>,
  opts: {
    citationText: string;
    sectionIndex: number | null;
    polarity: CitationPolarity;
  },
): SeedCitation => ({
  citingCaseNumber: decisions[citingIdx].caseNumber,
  citedCaseNumber: decisions[citedIdx as DecisionIdx].caseNumber,
  ...opts,
});

const citations: SeedCitation[] = [
  // Cross-references (temporal ordering enforced by crossRef's types)
  crossRef(7, 6, {
    citationText: "sp. zn. 23 Cdo 3470/2015",
    sectionIndex: 0,
    polarity: "supportive",
  }),
  crossRef(8, 4, {
    citationText: "sp. zn. 30 Cdo 3543/2011",
    sectionIndex: 1,
    polarity: "neutral",
  }),
  // External citations (cited decision not in seed set)
  {
    citingCaseNumber: "23 Cdo 3470/2015",
    citedCaseNumber: null,
    citationText: "sp. zn. 23 Cdo 2999/2007",
    sectionIndex: 1,
    polarity: null,
  },
  {
    citingCaseNumber: "22 Cdo 1772/2010",
    citedCaseNumber: null,
    citationText: "sp. zn. 31 Cdo 2036/2008",
    sectionIndex: 1,
    polarity: null,
  },
  {
    citingCaseNumber: "29 ICdo 37/2013",
    citedCaseNumber: null,
    citationText: "sp. zn. 29 Odo 627/2004",
    sectionIndex: 1,
    polarity: null,
  },
  {
    citingCaseNumber: "21 Cdo 4509/2018",
    citedCaseNumber: null,
    citationText: "sp. zn. 21 Cdo 1384/2000",
    sectionIndex: 1,
    polarity: null,
  },
  {
    citingCaseNumber: "30 Cdo 3543/2011",
    citedCaseNumber: null,
    citationText: "sp. zn. 30 Cdo 1277/2009",
    sectionIndex: 1,
    polarity: null,
  },
  {
    citingCaseNumber: "29 Odo 756/2005",
    citedCaseNumber: null,
    citationText: "sp. zn. 34 Cm 38/2001",
    sectionIndex: 1,
    polarity: null,
  },
];

// ─── Seed runner ───────────────────────────────────────────

const ensureSearchPreviewConfig = async () => {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS unaccent`);
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_ts_config
        WHERE cfgname = 'stella_unaccent'
          AND cfgnamespace = 'public'::regnamespace
      ) THEN
        CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple);
      END IF;
    END
    $$;
  `);
  await db.execute(sql`
    ALTER TEXT SEARCH CONFIGURATION public.stella_unaccent
      ALTER MAPPING FOR
        asciiword,
        asciihword,
        hword_asciipart,
        word,
        hword,
        hword_part
      WITH unaccent, simple
  `);
};

export async function seedCaseLaw() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: NODE_ENV must not be 'production'.");
  }

  const scopedDb = createScopedDb(
    db,
    [],
    DEFAULT_ORG_ID,
    toSafeId<"user">(DEFAULT_USER_ID),
  );

  await ensureSearchPreviewConfig();

  // --- source (reuse existing if cz-ns was already created by ingestion) ---
  const existingSource = await db.query.caseLawSources.findFirst({
    where: { adapterKey: { eq: "cz-ns" } },
    columns: { id: true },
  });

  const sourceId =
    existingSource?.id ??
    (
      await db
        .insert(caseLawSources)
        .values({
          id: SOURCE_ID,
          adapterKey: "cz-ns",
          name: "Czech Supreme Court",
          enabled: true,
          lastSyncAt: new Date(),
          config: {},
        })
        .onConflictDoNothing()
        .returning({ id: caseLawSources.id })
    ).at(0)?.id ??
    SOURCE_ID;

  console.log(
    `Source: ${existingSource ? "reused existing" : "created"} (${sourceId})`,
  );

  // --- decisions ---
  let insertedCount = 0;
  const decisionIdsByCaseNumber = new Map<string, SafeId<"caseLawDecision">>();

  for (const d of decisions) {
    const id = decId(d.caseNumber);

    const { rowCount } = await db
      .insert(caseLawDecisions)
      .values({
        id,
        sourceId,
        caseNumber: d.caseNumber,
        ecli: d.ecli,
        court: d.court,
        country: d.country,
        language: d.language,
        decisionDate: d.decisionDate,
        decisionType: d.decisionType,
        sections: d.sections as DecisionSection[],
        fulltext: d.sections.map((s) => s.text).join("\n\n"),
        sourceUrl: d.sourceUrl,
        metadata: d.metadata,
        sourceHash: d.sourceHash,
      })
      .onConflictDoNothing();

    const existingDecision = await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          eq(caseLawDecisions.caseNumber, d.caseNumber),
          eq(caseLawDecisions.language, d.language),
        ),
      )
      .limit(1)
      .then((rows) => rows.at(0));

    if (!existingDecision) {
      throw new Error(`Seeded decision not found: ${d.caseNumber}`);
    }

    decisionIdsByCaseNumber.set(d.caseNumber, existingDecision.id);
    await indexDecision(existingDecision.id, scopedDb);

    if (rowCount > 0) {
      insertedCount++;
    }
  }

  console.log(
    `Decisions: ${insertedCount} inserted, ${decisions.length - insertedCount} skipped.`,
  );

  // --- citations ---
  let citInserted = 0;

  for (const [i, c] of citations.entries()) {
    const citingDecisionId = decisionIdsByCaseNumber.get(c.citingCaseNumber);
    const citedDecisionId = c.citedCaseNumber
      ? decisionIdsByCaseNumber.get(c.citedCaseNumber)
      : null;

    if (!citingDecisionId) {
      throw new Error(`Citing decision not found: ${c.citingCaseNumber}`);
    }
    if (c.citedCaseNumber && !citedDecisionId) {
      throw new Error(`Cited decision not found: ${c.citedCaseNumber}`);
    }

    const { rowCount } = await db
      .insert(caseLawCitations)
      .values({
        id: citId(`${c.citingCaseNumber}-${i}`),
        citingDecisionId,
        citedDecisionId,
        citationText: c.citationText,
        sectionIndex: c.sectionIndex,
        polarity: c.polarity,
      })
      .onConflictDoNothing();

    if (rowCount > 0) {
      citInserted++;
    }
  }

  console.log(
    `Citations: ${citInserted} inserted, ${citations.length - citInserted} skipped.`,
  );

  console.log("\nDone. Case law data seeded successfully.");
}

if (import.meta.main) {
  seedCaseLaw()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
