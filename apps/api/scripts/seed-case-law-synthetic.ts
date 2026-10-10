/**
 * Synthetic public decisions for the seeded local stack.
 *
 * The recorded fixtures hold three decisions per source: too few for a
 * results table to page, wrap or facet. These fill the Czech browser with
 * enough decisions for three pages at the smallest page size, across several
 * courts, years and decision types, with headnotes of varied length. A few
 * Slovak decisions keep a second jurisdiction in the corpus.
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
import type { DocumentAst } from "@stll/legal-ast/document-ast";
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
  },
] as const satisfies readonly SyntheticJurisdictionSpec[];

/** Pick by index from a non-empty list, wrapping around. */
const cycle = <T>(items: readonly [T, ...T[]], index: number): T =>
  items[index % items.length] ?? items[0];

const syntheticDocumentAst = ({
  caseNumber,
  court,
  decisionDate,
  decisionType,
  fulltext,
}: {
  caseNumber: string;
  court: string;
  decisionDate: string;
  decisionType: string;
  fulltext: string;
}): DocumentAst => ({
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
  blocks: fulltext.split("\n\n").map((plainText, index) => {
    const number = index + 1;
    const anchorId = `p${String(number)}`;
    return {
      id: anchorId,
      anchorId,
      type: "paragraph",
      number,
      inlines: [{ type: "text", text: plainText }],
      plainText,
    };
  }),
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

  return {
    case_number: caseNumber,
    slug: null,
    ecli: null,
    court: court.name,
    country: spec.country,
    language: spec.language,
    language_group_key: `${spec.adapterKey}:${caseNumber}`,
    decision_date: decisionDate,
    decision_type: decisionType,
    fulltext,
    sections: segmentDecision(fulltext),
    document_ast: syntheticDocumentAst({
      caseNumber,
      court: court.name,
      decisionDate,
      decisionType,
      fulltext,
    }),
    analysis: null,
    parser_version: null,
    source_raw: null,
    source_raw_s3_key: null,
    source_raw_content_type: null,
    source_url: null,
    document_url: null,
    metadata: {
      ...(variant !== 3 && { [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: headnote }),
      keywords: [...topic.keywords],
    },
    source_hash: null,
  };
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
    decisions: Array.from({ length: spec.decisionCount }, (_unused, index) =>
      syntheticDecision(spec, index),
    ),
  }));
