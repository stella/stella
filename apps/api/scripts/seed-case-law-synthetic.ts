/**
 * Synthetic public decisions for the seeded local stack.
 *
 * The recorded fixtures hold three decisions per source: too few for a
 * results table to page, wrap or facet. These fill the Czech browser with
 * enough decisions for three pages at the smallest page size, across several
 * courts, years and decision types, with headnotes of varied length. A few
 * Slovak decisions keep a second jurisdiction in the corpus.
 *
 * A few Czech decisions are written out by hand instead
 * (`AUTHORED_CZ_DECISIONS`): their text cites provisions of the seeded labour
 * code, which `seed-case-law-provisions.ts` links, and one carries the
 * placeholders a publishing court leaves where it anonymized a name.
 *
 * Every party, case number and sentence is invented: the case numbers carry
 * a `DEMO` prefix no court uses, the parties are "sample" companies, and each
 * text says it is fictional. Courts are real institutions, so the court
 * registry ranks and groups them as it would real decisions.
 *
 * Generated, not recorded: the same call always returns the same rows, so
 * the seed's deterministic ids keep re-runs idempotent.
 */

import { DECISION_TEXT_FIELD } from "@stll/api-contract/case-law-text-field";
import { plainTextOf } from "@stll/legal-ast/document-ast";
import type { DocumentAst, Inline } from "@stll/legal-ast/document-ast";
import { Temporal } from "@stll/time";

import {
  FIXTURE_SOURCE_KEYS,
  type FixtureSourceKey,
} from "@/api/lib/legal-search/adapter-manifest";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import { segmentDecision } from "@/api/lib/legal-search/segment-decision";

import type { CaseLawFixture, FixtureDecision } from "./seed-case-law";

/** Invented public-domain text: served, searched and readable by AI. */
const SYNTHETIC_SOURCE_DESCRIPTOR = {
  license: "public-domain",
  attribution: null,
  allowsRedistribution: true,
  allowsDerivedAi: true,
} as const satisfies CorpusSourceDescriptor;

/**
 * A word every synthetic decision of a jurisdiction contains (from its
 * fiction notice), so one query reaches all of them.
 */
export const SYNTHETIC_CASE_LAW_QUERY = {
  CZE: "fiktivní",
  SVK: "fiktívne",
} as const;

type SyntheticJurisdiction = keyof typeof SYNTHETIC_CASE_LAW_QUERY;

type SyntheticCourt = {
  name: string;
  /** Register mark in the invented case number. */
  register: string;
  decisionTypes: readonly [string, ...string[]];
};

type SyntheticTopic = {
  courts: readonly [SyntheticCourt, ...SyntheticCourt[]];
  parties: (first: string, second: string) => string;
  subject: string;
  ruling: string;
  facts: string;
  headnote: string;
  keywords: readonly string[];
};

type SyntheticJurisdictionSpec = {
  country: SyntheticJurisdiction;
  language: string;
  adapterKey: FixtureSourceKey;
  sourceName: string;
  decisionCount: number;
  firstYear: number;
  yearSpan: number;
  topics: readonly [SyntheticTopic, ...SyntheticTopic[]];
  /** Appended to every fourth headnote so its row wraps. */
  headnoteExtension: string;
  render: (parts: RenderParts) => string;
  /** Written out by hand, seeded after the generated decisions. */
  authored: readonly AuthoredDecision[];
};

type RenderParts = {
  caseNumber: string;
  court: string;
  decisionType: string;
  parties: string;
  subject: string;
  ruling: string;
  facts: string;
  headnote: string;
};

const PARTY_NAMES = [
  "Alfa",
  "Beta",
  "Gama",
  "Delta",
  "Epsilon",
  "Zéta",
  "Éta",
  "Théta",
  "Jota",
  "Kappa",
  "Lambda",
] as const;

const CZ_SUPREME: SyntheticCourt = {
  name: "Nejvyšší soud",
  register: "Cdo",
  decisionTypes: ["rozsudek", "usnesení"],
};
const CZ_REGIONAL: SyntheticCourt = {
  name: "Krajský soud v Brně",
  register: "Co",
  decisionTypes: ["rozsudek", "usnesení"],
};
const CZ_DISTRICT: SyntheticCourt = {
  name: "Okresní soud v Ostravě",
  register: "C",
  decisionTypes: ["rozsudek", "usnesení"],
};
const CZ_ADMINISTRATIVE: SyntheticCourt = {
  name: "Nejvyšší správní soud",
  register: "As",
  decisionTypes: ["rozsudek", "usnesení"],
};
const CZ_CONSTITUTIONAL: SyntheticCourt = {
  name: "Ústavní soud",
  register: "ÚS",
  decisionTypes: ["nález", "usnesení"],
};

const czCivilParties = (first: string, second: string) =>
  `žalobkyně Ukázková společnost ${first} s.r.o. proti žalované Vzorová společnost ${second} a.s.`;
const czAdministrativeParties = (first: string) =>
  `žalobkyně Ukázková společnost ${first} s.r.o. proti žalovanému Ukázkový krajský úřad`;

const CZ_TOPICS = [
  {
    courts: [CZ_SUPREME, CZ_REGIONAL, CZ_DISTRICT],
    parties: czCivilParties,
    subject: "o náhradu škody z vadně provedeného díla",
    ruling:
      "Žalované se ukládá zaplatit žalobkyni náhradu škody ve výši 120 000 Kč.",
    facts:
      "Žalobkyně se domáhala náhrady škody, která jí vznikla tím, že žalovaná jako zhotovitelka provedla dílo s vadami, o nichž věděla.",
    headnote:
      "Zhotovitel odpovídá za škodu způsobenou vadným provedením díla i tehdy, když objednatel vady včas nevytkl, pokud o nich zhotovitel věděl.",
    keywords: ["smlouva o dílo", "náhrada škody", "vady díla"],
  },
  {
    courts: [CZ_REGIONAL, CZ_SUPREME],
    parties: czCivilParties,
    subject: "o přivolení k výpovědi z nájmu bytu",
    ruling: "Žaloba se zamítá.",
    facts:
      "Pronajímatelka vypověděla nájem bytu a nájemkyně namítala, že výpověď neobsahuje určitě vymezený výpovědní důvod.",
    headnote:
      "Výpověď z nájmu bytu musí obsahovat určitě vymezený výpovědní důvod; pouhý odkaz na zákonné ustanovení nestačí.",
    keywords: ["nájem bytu", "výpověď z nájmu", "výpovědní důvod"],
  },
  {
    courts: [CZ_SUPREME, CZ_REGIONAL],
    parties: czCivilParties,
    subject: "o zaplacení kupní ceny",
    ruling: "Žaloba se zamítá.",
    facts:
      "Prodávající uplatnila nárok na zaplacení kupní ceny a kupující vznesla námitku promlčení.",
    headnote:
      "Promlčecí lhůta k uplatnění nároku na zaplacení kupní ceny počíná běžet dnem splatnosti, nikoli dnem dodání zboží.",
    keywords: ["kupní smlouva", "promlčení", "splatnost"],
  },
  {
    courts: [CZ_SUPREME, CZ_REGIONAL],
    parties: czCivilParties,
    subject: "o určení neplatnosti výpovědi z pracovního poměru",
    ruling: "Výpověď z pracovního poměru je neplatná.",
    facts:
      "Zaměstnavatelka v průběhu řízení uváděla jiný výpovědní důvod, než jaký uvedla v písemné výpovědi.",
    headnote:
      "Zaměstnavatel nemůže dodatečně měnit výpovědní důvod uvedený v písemné výpovědi.",
    keywords: ["pracovní poměr", "výpověď", "neplatnost právního jednání"],
  },
  {
    courts: [CZ_ADMINISTRATIVE],
    parties: czAdministrativeParties,
    subject: "o přezkoumání rozhodnutí o odnětí řidičského oprávnění",
    ruling:
      "Rozhodnutí žalovaného se zrušuje a věc se vrací žalovanému k dalšímu řízení.",
    facts:
      "Žalobkyně namítala, že správní orgán nevypořádal její námitky proti způsobu měření rychlosti.",
    headnote:
      "Správní orgán musí v odůvodnění rozhodnutí vypořádat všechny námitky účastníka řízení, jinak je rozhodnutí nepřezkoumatelné.",
    keywords: ["správní řízení", "nepřezkoumatelnost", "řidičské oprávnění"],
  },
  {
    courts: [CZ_ADMINISTRATIVE],
    parties: czAdministrativeParties,
    subject: "o přezkoumání rozhodnutí o umístění stavby",
    ruling: "Kasační stížnost se zamítá.",
    facts:
      "Vlastnice sousedního pozemku nebyla přizvána do územního řízení, ačkoli stavba měla zastínit její pozemek.",
    headnote:
      "Vlastník sousedního pozemku je účastníkem územního řízení, může-li být jeho vlastnické právo umístěním stavby přímo dotčeno.",
    keywords: ["územní řízení", "účastenství", "stavební právo"],
  },
  {
    courts: [CZ_CONSTITUTIONAL],
    parties: (first) => `stěžovatelky Ukázková společnost ${first} s.r.o.`,
    subject: "o ústavní stížnosti pro průtahy v řízení",
    ruling:
      "Postupem obecného soudu bylo porušeno právo stěžovatelky na projednání věci bez zbytečných průtahů.",
    facts:
      "Řízení o žalobě stěžovatelky trvalo před obecnými soudy více než osm let, aniž by k tomu vedla složitost věci.",
    headnote:
      "Nepřiměřená délka soudního řízení zasahuje do práva na spravedlivý proces, i když věc nakonec skončí ve prospěch stěžovatele.",
    keywords: ["spravedlivý proces", "průtahy v řízení", "ústavní stížnost"],
  },
  {
    courts: [CZ_REGIONAL, CZ_SUPREME],
    parties: czCivilParties,
    subject: "o plnění z pojistné smlouvy",
    ruling:
      "Žalované se ukládá zaplatit žalobkyni pojistné plnění ve výši 85 000 Kč.",
    facts:
      "Pojistitelka odmítla plnění s odkazem na to, že pojištěná nahlásila pojistnou událost se zpožděním.",
    headnote:
      "Pojistitel nemůže odmítnout plnění pro porušení povinnosti pojištěného, které nemělo vliv na vznik ani rozsah pojistné události.",
    keywords: ["pojistná smlouva", "pojistné plnění", "pojistná událost"],
  },
] as const satisfies readonly SyntheticTopic[];

const CZ_FICTION_NOTICE =
  "Toto rozhodnutí je fiktivní. Vzniklo jen pro místní vývoj a testování a nepopisuje žádnou skutečnou věc, osobu ani řízení.";

const renderCzech = (parts: RenderParts) =>
  [
    parts.caseNumber,
    parts.decisionType.toLocaleUpperCase("cs"),
    `${parts.court} rozhodl ve věci ${parts.parties} ${parts.subject}, takto:`,
    "Výrok:",
    parts.ruling,
    "Odůvodnění:",
    parts.facts,
    parts.headnote,
    CZ_FICTION_NOTICE,
    "Poučení:",
    "Proti tomuto rozhodnutí nejsou opravné prostředky přípustné.",
  ].join("\n\n");

/**
 * A provision citation as a decision prints it: the provision, then the act
 * it belongs to. Every occurrence of the two, one space apart, is a link.
 */
export type AuthoredProvisionCitation = {
  provision: string;
  act: string;
};

/** A paragraph as plain text, or as inline runs where part of it is anonymized. */
type AuthoredParagraph = string | readonly Inline[];

type AuthoredDecision = {
  caseNumber: string;
  court: string;
  decisionType: string;
  decisionDate: string;
  headnote: string;
  keywords: readonly string[];
  paragraphs: readonly AuthoredParagraph[];
  provisionCitations: readonly AuthoredProvisionCitation[];
};

/** Text the publishing court anonymized; the reader brackets it. */
const anonymized = (text: string): Inline => ({
  type: "text",
  text,
  anonymized: true,
});
const plain = (text: string): Inline => ({ type: "text", text });

const LABOUR_CODE = "zákoníku práce";
const EMPLOYMENT_PARTIES =
  "žalobce, zaměstnance žalované, proti žalované Vzorová společnost Omega a.s.";

/**
 * Labour disputes applying § 51 of the seeded labour code, from three courts,
 * and one district-court judgment with anonymized names. Each linked decision
 * cites the section itself, which is the key the provision's inspector lists
 * decisions under, and one of its subsections. They are dated after the
 * seeded consolidation carrying § 51 took effect, so the version a link opens
 * by the decision's date holds the cited wording.
 */
const AUTHORED_CZ_DECISIONS = [
  {
    caseNumber: "DEMO 21 Cdo 901/2025",
    court: CZ_SUPREME.name,
    decisionType: "rozsudek",
    decisionDate: "2025-11-12",
    headnote:
      "Výpovědní doba počíná běžet dnem doručení výpovědi druhé smluvní straně, nikoli dnem jejího odeslání.",
    keywords: ["pracovní poměr", "výpověď", "výpovědní doba"],
    paragraphs: [
      "DEMO 21 Cdo 901/2025",
      "ROZSUDEK",
      `Nejvyšší soud rozhodl ve věci ${EMPLOYMENT_PARTIES} o určení trvání pracovního poměru, takto:`,
      "Výrok:",
      "Dovolání žalované se zamítá.",
      "Odůvodnění:",
      `Žalovaná dala žalobci výpověď z pracovního poměru a odeslala ji poslední den měsíce. Podle § 51 odst. 1 ${LABOUR_CODE} skončí pracovní poměr, byla-li dána výpověď, uplynutím výpovědní doby, která začíná dnem doručení výpovědi druhé smluvní straně.`,
      `Ustanovení § 51 ${LABOUR_CODE} upravuje výpovědní dobu jednotně pro zaměstnavatele i zaměstnance. Odvolací soud proto správně dovodil, že výpovědní doba nezačala běžet dříve, než žalobce výpověď převzal, a že ujednání vázající její počátek na odeslání výpovědi je s § 51 ${LABOUR_CODE} v rozporu.`,
      CZ_FICTION_NOTICE,
      "Poučení:",
      "Proti tomuto rozsudku nejsou opravné prostředky přípustné.",
    ],
    provisionCitations: [
      { provision: "§ 51 odst. 1", act: LABOUR_CODE },
      { provision: "§ 51", act: LABOUR_CODE },
    ],
  },
  {
    caseNumber: "DEMO 15 Co 902/2026",
    court: CZ_REGIONAL.name,
    decisionType: "rozsudek",
    decisionDate: "2026-02-18",
    headnote:
      "Výpovědní dobu lze prodloužit jen písemnou dohodou, která ji upravuje stejně pro zaměstnavatele i zaměstnance.",
    keywords: ["pracovní poměr", "výpovědní doba", "dohoda o výpovědní době"],
    paragraphs: [
      "DEMO 15 Co 902/2026",
      "ROZSUDEK",
      `Krajský soud v Brně jako soud odvolací rozhodl ve věci ${EMPLOYMENT_PARTIES} o zaplacení náhrady mzdy, takto:`,
      "Výrok:",
      "Rozsudek soudu prvního stupně se potvrzuje.",
      "Odůvodnění:",
      `Pracovní smlouva prodlužovala výpovědní dobu na šest měsíců jen pro výpověď danou zaměstnancem. Podle § 51 odst. 3 ${LABOUR_CODE} lze výpovědní dobu prodloužit písemnou dohodou, musí však být sjednána stejně pro zaměstnavatele i zaměstnance.`,
      `Ujednání, které výpovědní dobu prodlužuje jen pro jednu smluvní stranu, odporuje § 51 ${LABOUR_CODE}, a pracovní poměr proto skončil uplynutím zákonné výpovědní doby.`,
      CZ_FICTION_NOTICE,
      "Poučení:",
      "Proti tomuto rozsudku nejsou opravné prostředky přípustné.",
    ],
    provisionCitations: [
      { provision: "§ 51 odst. 3", act: LABOUR_CODE },
      { provision: "§ 51", act: LABOUR_CODE },
    ],
  },
  {
    caseNumber: "DEMO 31 ÚS 903/2026",
    court: CZ_CONSTITUTIONAL.name,
    decisionType: "nález",
    decisionDate: "2026-05-06",
    headnote:
      "Výklad, který by počátek výpovědní doby vázal na odeslání výpovědi, zasahuje do práva na spravedlivý proces.",
    keywords: ["spravedlivý proces", "výpovědní doba", "ústavní stížnost"],
    paragraphs: [
      "DEMO 31 ÚS 903/2026",
      "NÁLEZ",
      "Ústavní soud rozhodl o ústavní stížnosti stěžovatele, bývalého zaměstnance Vzorové společnosti Omega a.s., proti rozsudku obecného soudu, takto:",
      "Výrok:",
      "Rozsudkem obecného soudu bylo porušeno právo stěžovatele na spravedlivý proces.",
      "Odůvodnění:",
      `Obecný soud vyložil § 51 ${LABOUR_CODE} tak, že výpovědní doba běží již ode dne, kdy zaměstnavatel výpověď odeslal.`,
      `Takový výklad se příčí znění § 51 odst. 1 ${LABOUR_CODE}, podle něhož výpovědní doba začíná dnem doručení výpovědi druhé smluvní straně, a zbavuje stěžovatele ochrany, kterou mu zákon poskytuje.`,
      CZ_FICTION_NOTICE,
      "Poučení:",
      "Proti nálezu Ústavního soudu se nelze odvolat.",
    ],
    provisionCitations: [
      { provision: "§ 51", act: LABOUR_CODE },
      { provision: "§ 51 odst. 1", act: LABOUR_CODE },
    ],
  },
  {
    caseNumber: "DEMO 24 C 904/2025",
    court: CZ_DISTRICT.name,
    decisionType: "rozsudek",
    decisionDate: "2025-09-30",
    headnote:
      "Zaměstnavatel, který tvrdí, že výpověď doručil, musí doručení prokázat.",
    keywords: ["pracovní poměr", "doručení výpovědi", "důkazní břemeno"],
    paragraphs: [
      "DEMO 24 C 904/2025",
      "ROZSUDEK",
      [
        plain("Okresní soud v Ostravě rozhodl samosoudcem "),
        anonymized("tituly před jménem"),
        plain(" "),
        anonymized("jméno FO"),
        plain(" ve věci žalobce "),
        anonymized("jméno FO"),
        plain(", narozeného "),
        anonymized("datum narození"),
        plain(", bytem "),
        anonymized("adresa"),
        plain(
          ", proti žalované Vzorová společnost Sigma a.s. o určení neplatnosti výpovědi z pracovního poměru, takto:",
        ),
      ],
      "Výrok:",
      "Výpověď z pracovního poměru je neplatná.",
      "Odůvodnění:",
      [
        plain("Žalobce "),
        anonymized("jméno FO"),
        plain(" tvrdil, že mu výpověď nebyla doručena. Svědkyně "),
        anonymized("tituly před jménem"),
        plain(" "),
        anonymized("jméno FO"),
        plain(
          ", vedoucí personálního oddělení žalované, uvedla, že výpověď vložila do schránky v místě bydliště žalobce.",
        ),
      ],
      "Žalovaná doručení výpovědi neprokázala, a výpověď proto nenabyla účinnosti.",
      CZ_FICTION_NOTICE,
      "Poučení:",
      "Proti tomuto rozsudku lze podat odvolání do patnácti dnů od jeho doručení.",
    ],
    provisionCitations: [],
  },
] as const satisfies readonly AuthoredDecision[];

/** The provisions each authored decision prints, by case number. */
export const AUTHORED_PROVISION_CITATIONS: ReadonlyMap<
  string,
  readonly AuthoredProvisionCitation[]
> = new Map(
  AUTHORED_CZ_DECISIONS.map(({ caseNumber, provisionCitations }) => [
    caseNumber,
    provisionCitations,
  ]),
);

const SK_SUPREME: SyntheticCourt = {
  name: "Najvyšší súd Slovenskej republiky",
  register: "Obdo",
  decisionTypes: ["rozsudok", "uznesenie"],
};
const SK_CONSTITUTIONAL: SyntheticCourt = {
  name: "Ústavný súd Slovenskej republiky",
  register: "ÚS",
  decisionTypes: ["nález"],
};

const SK_TOPICS = [
  {
    courts: [SK_SUPREME],
    parties: (first: string, second: string) =>
      `žalobkyne Ukážková spoločnosť ${first} s.r.o. proti žalovanej Vzorová spoločnosť ${second} a.s.`,
    subject: "o zaplatenie kúpnej ceny",
    ruling: "Dovolanie sa zamieta.",
    facts:
      "Predávajúca uplatnila nárok na zaplatenie kúpnej ceny a kupujúca vzniesla námietku premlčania.",
    headnote:
      "Premlčacia doba na uplatnenie nároku na zaplatenie kúpnej ceny začína plynúť dňom jej splatnosti.",
    keywords: ["kúpna zmluva", "premlčanie"],
  },
  {
    courts: [SK_CONSTITUTIONAL],
    parties: (first: string) =>
      `sťažovateľky Ukážková spoločnosť ${first} s.r.o.`,
    subject: "o sťažnosti pre zbytočné prieťahy v konaní",
    ruling:
      "Postupom všeobecného súdu bolo porušené právo sťažovateľky na prerokovanie veci bez zbytočných prieťahov.",
    facts:
      "Konanie o žalobe sťažovateľky trvalo pred všeobecnými súdmi viac ako sedem rokov.",
    headnote:
      "Zbytočné prieťahy v súdnom konaní zasahujú do práva na prerokovanie veci bez zbytočných prieťahov.",
    keywords: ["prieťahy v konaní", "ústavná sťažnosť"],
  },
] as const satisfies readonly SyntheticTopic[];

const SK_FICTION_NOTICE =
  "Toto rozhodnutie je fiktívne. Vzniklo len na lokálny vývoj a testovanie a neopisuje žiadnu skutočnú vec, osobu ani konanie.";

const renderSlovak = (parts: RenderParts) =>
  [
    parts.caseNumber,
    parts.decisionType.toLocaleUpperCase("sk"),
    `${parts.court} rozhodol vo veci ${parts.parties} ${parts.subject} takto:`,
    "Výrok:",
    parts.ruling,
    "Odôvodnenie:",
    parts.facts,
    parts.headnote,
    SK_FICTION_NOTICE,
    "Poučenie:",
    "Proti tomuto rozhodnutiu nie je prípustný opravný prostriedok.",
  ].join("\n\n");

const JURISDICTIONS = [
  {
    country: "CZE",
    language: "cs",
    adapterKey: FIXTURE_SOURCE_KEYS.SYNTHETIC_CZ,
    sourceName: "Synthetic decisions (CZ, local development)",
    // Three pages at the smallest page size, the third one partial.
    decisionCount: 56,
    firstYear: 2018,
    yearSpan: 8,
    topics: CZ_TOPICS,
    headnoteExtension:
      " Soud k tomu dodává, že při posouzení věci je třeba přihlédnout ke všem okolnostem případu, zejména k průběhu dosavadního řízení, k chování účastníků a k tomu, zda vytýkaná vada mohla mít vliv na obsah výroku; formální nedostatky bez takového vlivu samy o sobě důvodem ke zrušení rozhodnutí nejsou.",
    render: renderCzech,
    authored: AUTHORED_CZ_DECISIONS,
  },
  {
    country: "SVK",
    language: "sk",
    adapterKey: FIXTURE_SOURCE_KEYS.SYNTHETIC_SK,
    sourceName: "Synthetic decisions (SK, local development)",
    decisionCount: 8,
    firstYear: 2020,
    yearSpan: 5,
    topics: SK_TOPICS,
    headnoteExtension:
      " Súd zároveň uvádza, že pri posúdení veci treba prihliadnuť na všetky okolnosti prípadu, najmä na doterajší priebeh konania a na správanie účastníkov.",
    render: renderSlovak,
    authored: [],
  },
] as const satisfies readonly SyntheticJurisdictionSpec[];

/** Pick by index from a non-empty list, wrapping around. */
const cycle = <T>(items: readonly [T, ...T[]], index: number): T =>
  items[index % items.length] ?? items[0];

type SyntheticDecisionParts = {
  spec: SyntheticJurisdictionSpec;
  caseNumber: string;
  court: string;
  decisionDate: string;
  decisionType: string;
  paragraphs: readonly AuthoredParagraph[];
  metadata: Record<string, unknown>;
};

/** One paragraph block per paragraph; the text is the blocks', joined. */
const syntheticFixtureDecision = ({
  spec,
  caseNumber,
  court,
  decisionDate,
  decisionType,
  paragraphs,
  metadata,
}: SyntheticDecisionParts): FixtureDecision => {
  const blocks = paragraphs.map((paragraph, index) => {
    const inlines =
      typeof paragraph === "string" ? [plain(paragraph)] : paragraph;
    const number = index + 1;
    const anchorId = `p${String(number)}`;
    return {
      id: anchorId,
      anchorId,
      type: "paragraph" as const,
      number,
      inlines: [...inlines],
      plainText: plainTextOf(inlines),
    };
  });
  const fulltext = blocks.map(({ plainText }) => plainText).join("\n\n");
  const documentAst: DocumentAst = {
    version: 1,
    source: {
      system: "stella-synthetic-seed",
      documentId: caseNumber,
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber,
      ecli: null,
      court,
      decisionDate,
      decisionType,
      keywords: [],
      statutes: [],
    },
    blocks,
  };
  return {
    case_number: caseNumber,
    slug: null,
    ecli: null,
    court,
    country: spec.country,
    language: spec.language,
    language_group_key: `${spec.adapterKey}:${caseNumber}`,
    decision_date: decisionDate,
    decision_type: decisionType,
    fulltext,
    sections: segmentDecision(fulltext),
    document_ast: documentAst,
    analysis: null,
    parser_version: null,
    source_raw: null,
    source_raw_s3_key: null,
    source_raw_content_type: null,
    source_url: null,
    document_url: null,
    metadata,
    source_hash: null,
  };
};

const authoredDecision = (
  spec: SyntheticJurisdictionSpec,
  decision: AuthoredDecision,
): FixtureDecision =>
  syntheticFixtureDecision({
    spec,
    caseNumber: decision.caseNumber,
    court: decision.court,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType,
    paragraphs: decision.paragraphs,
    metadata: {
      [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: decision.headnote,
      keywords: [...decision.keywords],
    },
  });

const syntheticDecision = (
  spec: SyntheticJurisdictionSpec,
  index: number,
): FixtureDecision => {
  const topic = cycle(spec.topics, index);
  const round = Math.floor(index / spec.topics.length);
  const court = cycle(topic.courts, round);
  // Types and years advance on their own strides, out of step with the topic
  // and court cycles, so each court and year holds a mix.
  const decisionType = cycle(court.decisionTypes, Math.floor(index / 3));
  const year = spec.firstYear + (Math.floor(index / 7) % spec.yearSpan);
  const caseNumber = `DEMO ${String(20 + (index % 13))} ${court.register} ${String(100 + index)}/${String(year)}`;
  // One headnote in four runs long enough to wrap and one decision in four
  // has keywords only, so its row falls back to them. Offset by the round so
  // a topic does not always land on the same variant.
  const variant = (index + round) % 4;
  const headnote =
    variant === 0
      ? `${topic.headnote}${spec.headnoteExtension}`
      : topic.headnote;
  const fulltext = spec.render({
    caseNumber,
    court: court.name,
    decisionType,
    parties: topic.parties(
      cycle(PARTY_NAMES, index),
      cycle(PARTY_NAMES, index + 5),
    ),
    subject: topic.subject,
    ruling: topic.ruling,
    facts: topic.facts,
    headnote,
  });
  const decisionDate = Temporal.PlainDate.from({
    year,
    month: ((index * 5) % 12) + 1,
    day: ((index * 11) % 28) + 1,
  }).toString();

  return syntheticFixtureDecision({
    spec,
    caseNumber,
    court: court.name,
    decisionDate,
    decisionType,
    paragraphs: fulltext.split("\n\n"),
    metadata: {
      ...(variant !== 3 && { [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: headnote }),
      keywords: [...topic.keywords],
    },
  });
};

export const syntheticCaseLawFixtures = (): CaseLawFixture[] =>
  JURISDICTIONS.map((spec) => ({
    source: {
      adapter_key: spec.adapterKey,
      name: spec.sourceName,
      // No ingestion adapter serves these keys; an enabled source would be
      // scheduled for syncs that cannot run.
      enabled: false,
      config: null,
      descriptor: SYNTHETIC_SOURCE_DESCRIPTOR,
    },
    decisions: [
      ...Array.from({ length: spec.decisionCount }, (_unused, index) =>
        syntheticDecision(spec, index),
      ),
      ...spec.authored.map((decision) => authoredDecision(spec, decision)),
    ],
  }));
