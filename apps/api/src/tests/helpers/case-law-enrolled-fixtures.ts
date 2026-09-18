/**
 * A decision per enrolled case-law adapter, built from payloads shaped like
 * the ones its publisher serves.
 *
 * Two guards read the same decisions: the field inventory asks what the stored
 * envelope states and whether the row carries it, and the surface census asks
 * which of the publisher's pages that envelope holds at all. They have to
 * agree about what an adapter stores, so they are driven from one set of
 * fixtures rather than from two that can drift apart.
 *
 * Each fixture is the union of what the source's pages state: every label the
 * publisher is known to print, with a value in it, because a disposition is
 * only exercised where the decision built from the fixture can be checked for
 * it.
 *
 * Building a decision replaces `globalThis.fetch` for the adapters that reach
 * their publisher through it, so a suite using these restores the original in
 * an `afterEach`.
 */

import { panic } from "better-result";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { AT_ASYLGH_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-asylgh";
import { AT_BKS_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-bks";
import { AT_BVWG_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-bvwg";
import {
  assembleAtRisDecision,
  AT_COURTS_SOURCE,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";
import type { AtRisSourceDefinition } from "@/api/handlers/case-law/ingestion/adapters/at-courts";
import {
  assembleAtFindokDecision,
  parseFindokManifest,
} from "@/api/handlers/case-law/ingestion/adapters/at-findok";
import { AT_LVWG_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-lvwg";
import {
  AT_RIS_APPLICATIONS,
  atRisBranchElement,
} from "@/api/handlers/case-law/ingestion/adapters/at-ris-fields";
import type {
  AtRisBranchField,
  AtRisDocumentField,
} from "@/api/handlers/case-law/ingestion/adapters/at-ris-fields";
import { AT_UBAS_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-ubas";
import { AT_UMSE_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-umse";
import { AT_UVS_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-uvs";
import { AT_VERG_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-verg";
import { AT_VFGH_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-vfgh";
import { AT_VWGH_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-vwgh";
import { buildCzNsDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { buildCzNssDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import {
  assembleCzRegionalDecision,
  czRegionalAdapter,
  czRegionalEnvelopeWithChain,
  readCzRegionalDocument,
} from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import type { CzRegionalApiItem } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { buildCzUsDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import type { ListedDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import {
  assembleHuBhgyDecision,
  huBhgyDocumentOf,
  huBhgyRawPartsOf,
  normalizeHuBhgyRow,
} from "@/api/handlers/case-law/ingestion/adapters/hu-bhgy";
import {
  buildPlDecision,
  normalizeSaosDumpItem,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import {
  assemblePlSnDecision,
  normalizePlSnDetail,
  readPlSnEnvelope,
} from "@/api/handlers/case-law/ingestion/adapters/pl-sn";
import { assembleSkCourtsDecision } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { buildSkUsDecision } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import { withSourceRawObjects } from "@/api/lib/legal-search/ingestion-types";
import {
  RAW_SOURCE_FAMILY,
  sourceBinaryRef,
} from "@/api/lib/legal-search/raw-source-storage";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

/** What a guard has to drive one adapter with. */
export type EnrolledAdapterFixture = {
  /** The decision this adapter builds from the payloads it was served. */
  readonly buildDecision: () => Promise<IngestionResult>;
};

// ── CZ NS fixture ────────────────────────────────────────

/**
 * A labelled row of the detail page: label cell, then the value the court
 * prints in a `<font>` run.
 */
const czNsDetailRow = (label: string, value: string): string =>
  `<tr valign="top"><td class="left-part" width="17%"><b><font face="Times New Roman">${label}:</font></b></td>` +
  `<td class="right-part" width="83%"><b><font face="Times New Roman">${value}</font></b></td></tr>`;

/** The headnote and annotation rows, whose cells hold no `<font>` run. */
const czNsProseRow = (label: string, value: string): string =>
  `<tr valign="top"><td class="left-part" width="17%"><b><font face="Times New Roman">${label}:</font></b></td>` +
  `<td class="right-part" width="83%">${value}</td></tr>`;

/**
 * The related-proceedings table, which the court prints as a row spanning the
 * page rather than as a labelled cell.
 */
const CZ_NS_CONSTITUTIONAL_COMPLAINT_TABLE =
  `<tr valign="top"><td width="100%" colspan="2"><b><font face="Times New Roman CE">Podána ústavní stížnost</font></b>` +
  `<table><tr><td>datum podání</td><td>spisová značka</td></tr>` +
  `<tr><td>03/21/2016</td><td>IV.ÚS 924/16</td></tr></table></td></tr>`;

const CZ_NS_HEADNOTE =
  "Uloží-li soud rodičům povinnost účastnit se mediačního jednání, jde o " +
  "rozhodnutí, jímž se upravuje řízení.";

const CZ_NS_ANNOTATION =
  "Okresní soud uložil rodičům povinnost účastnit se mediačního jednání.";

/** Enough of a decision for the parser to build a document from. */
const CZ_NS_DECISION_BODY =
  "Nejvyšší soud rozhodl v senátě složeném z předsedy JUDr. Pavla Horáka, " +
  "Ph.D., takto: Dovolání se odmítá. Odůvodnění: Soud prvního stupně " +
  "rozsudkem zamítl žalobu. JUDr. Pavel Horák, Ph.D.\npředseda senátu";

/**
 * The detail page, carrying every row this court is known to label. Both
 * docket labels are on it: the court prints `Spisová značka` for most of its
 * registers and `Senátní značka` for the insolvency one, and a fixture with
 * only the first would never exercise the second's disposition.
 */
const CZ_NS_DETAIL_PAGE = `<!DOCTYPE HTML><html><body><table>${[
  czNsProseRow("Právní věta", `<b>${CZ_NS_HEADNOTE}</b>`),
  czNsDetailRow("Soud", "Nejvyšší soud"),
  czNsDetailRow("Datum rozhodnutí", "28. 5. 2026"),
  czNsDetailRow("Spisová značka", "30 Cdo 3000/2025"),
  czNsDetailRow("Senátní značka", "30 Cdo 3000/2025"),
  czNsDetailRow("ECLI", "ECLI:CZ:NS:2026:30.CDO.3000.2025.1"),
  czNsDetailRow("Typ rozhodnutí", "ROZSUDEK"),
  czNsDetailRow("Heslo", "Dovolání"),
  czNsDetailRow("Dotčené předpisy", "§ 237 o. s. ř."),
  czNsDetailRow("Kategorie rozhodnutí", "E"),
  czNsDetailRow("Zveřejněno na webu", "10. 6. 2026"),
  czNsProseRow(
    "Anotace",
    `<details><summary></summary><p>${CZ_NS_ANNOTATION}</p></details>`,
  ),
  CZ_NS_CONSTITUTIONAL_COMPLAINT_TABLE,
].join(
  "",
)}</table><font face="Times New Roman">${CZ_NS_DECISION_BODY}</font></body></html>`;

/**
 * The print page, whose metadata table is where the parser reads the court,
 * the keywords and the related-proceedings table from.
 */
const CZ_NS_PRINT_PAGE =
  `<!DOCTYPE HTML><html><body><table id="box-table-a"><tbody>${[
    "<tr><td>Soud:</td><td>Nejvyšší soud</td></tr>",
    "<tr><td>Datum rozhodnutí:</td><td>05/28/2026</td></tr>",
    "<tr><td>Spisová značka:</td><td>30 Cdo 3000/2025</td></tr>",
    "<tr><td>ECLI:</td><td>ECLI:CZ:NS:2026:30.CDO.3000.2025.1</td></tr>",
    "<tr><td>Typ rozhodnutí:</td><td>ROZSUDEK</td></tr>",
    "<tr><td>Heslo:</td><td>Dovolání</td></tr>",
    "<tr><td>Dotčené předpisy:</td><td>§ 237 o. s. ř.</td></tr>",
    "<tr><td>Kategorie rozhodnutí:</td><td>E</td></tr>",
    CZ_NS_CONSTITUTIONAL_COMPLAINT_TABLE,
  ].join("")}</tbody></table>` +
  `<p align="center">ROZSUDEK</p>` +
  `<p>Nejvyšší soud rozhodl v senátě složeném z předsedy JUDr. Pavla Horáka, Ph.D., takto: Dovolání se odmítá.</p>` +
  `<p>Odůvodnění: Soud prvního stupně rozsudkem zamítl žalobu, kterou se žalobkyně domáhala zaplacení částky.</p>` +
  `<p>JUDr. Pavel Horák, Ph.D.<br />předseda senátu</p></body></html>`;

export const czNsFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () => {
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.includes("/WebPrint/")
        ? CZ_NS_PRINT_PAGE
        : CZ_NS_DETAIL_PAGE;
      return await Promise.resolve(
        new Response(body, { headers: { "Content-Type": "text/html" } }),
      );
    });

    const built = await buildCzNsDecision({
      unid: "0000000000000000000000000000000A",
      caseNumber: "30 Cdo 3000/2025",
    });
    return built.type === "built"
      ? built.decision
      : panic(`cz-ns fixture did not build: ${built.type}`);
  },
});

// ── CZ NSS fixture ───────────────────────────────────────

/**
 * One field of the detail page in the portal's own markup: a `data-field-id`
 * div whose label and value are two spans told apart by their class.
 */
const czNssDetailField = (fieldId: string, value: string): string =>
  `<div class="col-md-12 detcard" data-nss="nssview" data-field-id="${fieldId}">` +
  `<span class="det-textitle" title="${fieldId}">${fieldId} :</span>` +
  `<span class="det-textval" title="${value}"> ${value}</span></div>`;

const CZ_NSS_HEADNOTE =
  "Rozhodnutí v místním referendu, která jsou ze zákona neplatná, správní " +
  "soudy z hlediska dalších vad nepřezkoumávají.";

/**
 * What the portal states for the fields this fixture gives a value of its
 * own. Everything else on the page gets the placeholder below: the assertions
 * are about which fields are there, not about what a court wrote in them.
 */
const CZ_NSS_FIXTURE_VALUES: Readonly<Record<string, string>> = {
  citace: "1 Azs 4/2026-79, č. 4600/2026 Sb. NSS",
  datumvydanirozhodnuti: "10.06.2026",
  druhdokumentuavyrokrozhodnuti: "Rozsudek",
  ecli: "ECLI:CZ:NSS:2026:1.Azs.4.2026.79",
  nazevspravnihoorganu: "Ministerstvo vnitra",
  oblastupravy: "Azyl - Mezinárodní ochrana a setrvání v přijímacím středisku",
  pravnivetaanv: "ano",
  pravnivetaupravena: CZ_NSS_HEADNOTE,
  soudcezpravodaj: "JUDr. Lenka Kaniová",
  soudsenat: "Nejvyšší správní soud (1 Azs)",
  stavrizeni: "Skončeno",
  typrizeni: "Kasační stížnost",
  ucastnicirizeniz: "Ministerstvo vnitra",
  vyrokrozhodnuti: "zamítnuto",
};

/**
 * Every field id one of this portal's detail pages states, taken from the
 * pages it serves rather than from the inventory: a page states the fields
 * its document has, so this is the union over the document kinds the portal
 * publishes — a headnote and a cassation block included.
 */
const CZ_NSS_FIXTURE_FIELD_IDS = [
  "aktualizovano",
  "aplikovanepravnipredpisysb&#xA7;",
  "aplikovanepravnipredpisysbcislo",
  "aplikovanepravnipredpisysbcl",
  "aplikovanepravnipredpisysbodst",
  "aplikovanepravnipredpisysbpism",
  "aplikovanepravnipredpisysbpredpis",
  "aplikovanepravnipredpisysbrok",
  "aplikovanopravoeu",
  "citace",
  "cj",
  "datumnapadenehorozhodnuti",
  "datumpravnimoci",
  "datumpredkladacihorozhodnutinss",
  "datumrozhodnutikrajskehosoudu",
  "datumskonceniirizeni",
  "datumvydanirozhodnuti",
  "datumvyhotovenirozhodnuti",
  "datumvypravenirozhodnuti",
  "datumzahajenirizeni",
  "datumzahajenirizeninka",
  "druh",
  "druhdokumentuavyrokrozhodnuti",
  "ecli",
  "hvtparagrafy",
  "identifikacevesbirkach",
  "identifikacevesbirkachdelenejudikat",
  "identifikacevesbirkachdelenerok",
  "identifikacevesbirkachdelenesesit",
  "kasacnistiznostoznacenivecideleneclistu",
  "kasacnistiznostoznacenivecideleneporc",
  "kasacnistiznostoznacenivecidelenerejstrik",
  "kasacnistiznostoznacenivecidelenerok",
  "kasacnistiznostoznacenivecidelenesenat",
  "kasacnistiznostoznacenivecivcelku",
  "kasacniustavnistiznost",
  "krajskysoud",
  "napadeno",
  "nazevorganu",
  "nazevsoudusubjektu",
  "nazevspravnihoorganu",
  "oblastupravy",
  "oznacenivecidelenecislojednaci",
  "oznacenivecideleneporadovecislo",
  "oznacenivecidelenerejstrikovaznacka",
  "oznacenivecidelenerok",
  "oznacenivecidelenesenat",
  "oznacenivecivcelku",
  "podanakasacnistiznostD",
  "povaha",
  "pravnivetaupravena",
  "pravnivetaanv",
  "prejudikaturaoznacenivecideleneclistu",
  "prejudikaturaoznacenivecideleneporc",
  "prejudikaturaoznacenivecidelenerejstrik",
  "prejudikaturaoznacenivecidelenerok",
  "prejudikaturaoznacenivecidelenesenat",
  "prejudikaturaoznacenivecivcelku",
  "rozhodnuto",
  "rozhodnutivevztahukrizeni",
  "rozhodnutonapkasst",
  "sbnsspublikovano",
  "souladnaprejudikatura",
  "soudcezpravodaj",
  "soudsenat",
  "spzncjpredkladacihorozhodnutinss",
  "spzncjrizenipodani",
  "spzncjrozhodnutispravnihoorganu",
  "stavrizeni",
  "sz",
  "typrizeni",
  "typucastnika",
  "typzastupce",
  "ucastnicirizeniz",
  "ucastnikrizeni",
  "vyrokrozhodnuti",
  "zastupce",
  "zobrazovanedatum",
] as const;

/** Stands in wherever the value carries nothing the assertions read. */
const CZ_NSS_PLACEHOLDER_VALUE = "Ne";

const CZ_NSS_DETAIL_PAGE = `<html><body>${CZ_NSS_FIXTURE_FIELD_IDS.map(
  (fieldId) =>
    czNssDetailField(
      fieldId,
      CZ_NSS_FIXTURE_VALUES[fieldId] ?? CZ_NSS_PLACEHOLDER_VALUE,
    ),
).join("")}</body></html>`;

const CZ_NSS_DOCUMENT_PAGE = `<html><body>
  <p>ČESKÁ REPUBLIKA</p>
  <p>ROZSUDEK JMÉNEM REPUBLIKY</p>
  <p>Nejvyšší správní soud rozhodl v senátu složeném z předsedkyně JUDr. Lenky
  Kaniové ve věci žalobce proti žalovanému Ministerstvu vnitra, o kasační
  stížnosti žalobce proti rozsudku městského soudu, takto: Kasační stížnost se
  zamítá.</p>
</body></html>`;

export const czNssFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () => {
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.includes("/DokumentDetail/Index/")
        ? CZ_NSS_DETAIL_PAGE
        : CZ_NSS_DOCUMENT_PAGE;
      return await Promise.resolve(
        new Response(body, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );
    });

    const built = await buildCzNssDecision({
      row: {
        caseNumber: "1 Azs 4/2026",
        publishedCaseNumber: "1 Azs 4/2026-79",
        decisionDate: "10.06.2026",
        decisionType: "Rozsudek",
        outcome: undefined,
        documentUrl: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/784237",
        documentId: "784237",
      },
      session: { cookies: "", token: "", formFields: new Map() },
      signal: AbortSignal.timeout(30_000),
    });
    return built.type === "built"
      ? built.decision
      : panic(`cz-nss fixture did not build: ${built.type}`);
  },
});

// ── CZ Regional fixture ──────────────────────────────────

/** The listing row, as a day page states one. */
const CZ_REGIONAL_LISTING_ROW = {
  jednaciCislo: "26 Co 43/2026-49",
  soud: "Krajský soud v Hradci Králové",
  autor: "JUDr. Jana Marková",
  ecli: "ECLI:CZ:KSHK:2026:26.Co.43.2026.1",
  predmetRizeni: "o zaplacení 32 600 Kč s příslušenstvím",
  datumVydani: "2026-03-11",
  datumZverejneni: "2026-06-11",
  klicovaSlova: ["společné jmění manželů"],
  zminenaUstanoveni: ["§ 741 z. č. 89/2012 Sb."],
  odkaz:
    "https://rozhodnuti.justice.cz/api/finaldoc/00000000-0000-4000-8000-000000000001",
} satisfies CzRegionalApiItem;

/** One paragraph, in the shape every section of the document uses. */
const czRegionalParagraph = (
  text: string,
  styleLocalId: number,
): Record<string, unknown> => ({
  texts: [{ text, anonStyle: "NONE" }],
  styleLocalId,
  tableCellInfo: null,
});

/**
 * The document payload, carrying every key this publisher is known to state
 * and a value in each.
 *
 * Every key filled because the conformance suite walks what the fixture
 * states: a key left empty would declare a disposition nothing exercises.
 * `specialType` and `affectedDocs` are filled for the same reason — both are
 * empty on most decisions, and a fixture that left them so would certify
 * neither the EU-relevance markers nor the publisher's relation graph.
 */
const CZ_REGIONAL_DOCUMENT_PAYLOAD = JSON.stringify({
  uuid: "00000000-0000-4000-8000-000000000001",
  header: [
    czRegionalParagraph(
      "Krajský soud v Hradci Králové rozhodl v senátě složeném z předsedkyně JUDr. Jany Markové ve věci",
      3,
    ),
    {
      texts: [
        { text: "žalobce: ", anonStyle: "NONE" },
        { text: "Jméno žalobce", anonStyle: "ANON" },
      ],
      styleLocalId: 3,
      tableCellInfo: null,
    },
  ],
  verdict: [
    czRegionalParagraph("I. Rozsudek okresního soudu se potvrzuje.", 7),
  ],
  verdictText: "I. Rozsudek okresního soudu se potvrzuje.",
  justification: [
    czRegionalParagraph(
      "1. Okresní soud zamítl žalobu, kterou se žalobce domáhal zaplacení částky ze společného jmění manželů.",
      7,
    ),
    czRegionalParagraph(
      "2. Odvolací soud rozsudek okresního soudu jako věcně správný potvrdil.",
      7,
    ),
  ],
  justificationText:
    "1. Okresní soud zamítl žalobu, kterou se žalobce domáhal zaplacení částky ze společného jmění manželů. 2. Odvolací soud rozsudek okresního soudu jako věcně správný potvrdil.",
  information: [
    czRegionalParagraph("Proti tomuto rozsudku není dovolání přípustné.", 3),
  ],
  metadata: {
    type: "JUDGEMENT",
    ecli: "ECLI:CZ:KSHK:2026:26.Co.43.2026.1",
    publishedAt: "2026-06-11",
    decisionAt: "2026-03-11",
    caseNumber: {
      senate: 26,
      registry: "Co",
      index: 43,
      year: 2026,
      pageNumber: 49,
    },
    solver: {
      titlesBefore: "JUDr.",
      firstName: "Jana",
      lastName: "Marková",
      titlesAfter: "",
      function: "předsedkyně senátu",
    },
    courtCode: "KSHK",
    caseResultType: ["POTVRZENI"],
    caseSubject: "o zaplacení 32 600 Kč s příslušenstvím",
    specialType: ["EP1250"],
    affectedDocs: [
      {
        caseNumber: {
          senate: 18,
          registry: "C",
          index: 130,
          year: 2025,
          pageNumber: 27,
        },
        affectedDate: "2025-11-13",
        courtCode: "OSHK",
        affectedTypes: ["CONFIRM"],
        url: null,
      },
    ],
    regulations: [
      {
        paragraphNumber: "741",
        lexNumber: 89,
        lexYear: 2012,
        lexType: "PREDPIS_ZAKON",
      },
    ],
    flags: ["SPOLECNE_JMENI_MANZELU"],
  },
  styles: [
    {
      localId: 3,
      alignment: "LEFT",
      hasSpaceBefore: false,
      hasSpaceAfter: false,
      bold: false,
      italic: false,
    },
    {
      localId: 7,
      alignment: "LEFT",
      hasSpaceBefore: true,
      hasSpaceAfter: true,
      bold: true,
      italic: false,
    },
  ],
});

/**
 * The chain payload: one later decision affecting this one, with the id the
 * forward edge never states.
 */
const CZ_REGIONAL_CHAIN_PAYLOAD = JSON.stringify([
  {
    uuid: "00000000-0000-4000-8000-000000000002",
    caseNumber: {
      senate: 30,
      registry: "Cdo",
      index: 900,
      year: 2026,
      pageNumber: 71,
    },
    courtCode: "NS",
    affectedDate: "2026-09-02",
    affectedTypes: ["CANCEL"],
  },
]);

/**
 * Built through the two paths that write this source's envelope: the crawl
 * assembles the listing row with the document, and the chain pass adds the
 * part it alone fetches and re-parses the result. Driving both is what makes
 * the `chain` part evidence of a pass that exists rather than of a payload
 * written by hand.
 */
export const czRegionalFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () => {
    const crawled = assembleCzRegionalDecision({
      item: CZ_REGIONAL_LISTING_ROW,
      document: readCzRegionalDocument(CZ_REGIONAL_DOCUMENT_PAYLOAD),
      chain: null,
    });
    if (crawled.type !== "built") {
      return panic(`cz-regional fixture did not build: ${crawled.type}`);
    }
    const parts = decodeSourceRawEnvelope(crawled.decision.sourceRaw ?? "");
    if (parts === null) {
      return panic("the cz-regional fixture stored no envelope");
    }

    const reparsed = await czRegionalAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(
        czRegionalEnvelopeWithChain(parts, CZ_REGIONAL_CHAIN_PAYLOAD),
      ),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: crawled.decision.caseNumber,
      sourceDocumentId: crawled.decision.sourceDocumentId ?? null,
      language: crawled.decision.language,
      court: crawled.decision.court,
      ecli: crawled.decision.ecli ?? null,
      decisionDate: crawled.decision.decisionDate ?? null,
      decisionType: crawled.decision.decisionType ?? null,
      sourceUrl: crawled.decision.sourceUrl ?? null,
      documentUrl: crawled.decision.documentUrl ?? null,
      metadata: crawled.decision.metadata,
    });
    return reparsed?.type === "parsed"
      ? reparsed.result
      : panic(`cz-regional fixture did not re-parse: ${reparsed?.type}`);
  },
});

// ── PL courts fixture ────────────────────────────────────

/**
 * One judgment as the aggregator's per-judgment endpoint states it.
 *
 * Every key the three payloads are known to carry, each with a value in it:
 * a disposition is only exercised where the decision built from the fixture
 * can be checked for what it decided about. The bench carries all three
 * special roles this source states and the separate opinion names its
 * author, because those are the fields no single court's records show.
 */
const PL_COURTS_JUDGMENT = {
  id: 245_360,
  href: "https://www.saos.org.pl/api/judgments/245360",
  courtType: "SUPREME",
  courtCases: [
    { caseNumber: "III KK 195/16" },
    { caseNumber: "III KK 196/16" },
  ],
  judgmentType: "SENTENCE",
  judgmentDate: "2016-06-22",
  judges: [
    {
      name: "Józef Dołhy",
      function: "SSN",
      specialRoles: ["PRESIDING_JUDGE"],
    },
    {
      name: "Józef Szewczyk",
      function: "SSN",
      specialRoles: ["REASONS_FOR_JUDGMENT_AUTHOR", "REPORTING_JUDGE"],
    },
    { name: "Dariusz Świecki", function: "SSN", specialRoles: [] },
  ],
  textContent:
    "<h2>WYROK</h2><p>Sygn. akt III KK 195/16</p>" +
    "<p>Sąd Najwyższy oddala kasację jako oczywiście bezzasadną.</p>" +
    "<h2>UZASADNIENIE</h2><p>Treść uzasadnienia.</p>",
  keywords: ["kasacja"],
  division: {
    id: 13,
    href: "https://www.saos.org.pl/api/scDivisions/13",
    name: "Wydział III",
    code: "0013",
    type: "Karny",
    chamber: {
      id: 1,
      href: "https://www.saos.org.pl/api/scChambers/1",
      name: "Izba Karna",
    },
    court: {
      id: 1,
      href: "https://www.saos.org.pl/api/commonCourts/1",
      name: "Sąd Najwyższy",
      code: "00000000",
      type: "SUPREME",
    },
  },
  chambers: [
    {
      id: 1,
      href: "https://www.saos.org.pl/api/scChambers/1",
      name: "Izba Karna",
    },
  ],
  personnelType: "THREE_PERSON",
  judgmentForm: { name: "wyrok SN" },
  source: {
    code: "SUPREME_COURT",
    judgmentUrl: "http://www.sn.pl/orzecznictwo/SitePages/Baza_orzeczen",
    judgmentId: "dec1bfc4e752237043d129d346fa2543",
    publisher: "Biuro Studiów i Analiz",
    reviser: "Wydział Informacji",
    publicationDate: "2016-06-23",
  },
  courtReporters: ["Anna Kowalska"],
  decision: "oddala kasację",
  summary: "Kasacja oczywiście bezzasadna.",
  legalBases: ["art. 535 § 3 k.p.k."],
  referencedRegulations: [
    {
      journalTitle:
        "Ustawa z dnia 6 czerwca 1997 r. - Kodeks postępowania karnego",
      journalYear: 1997,
      journalNo: 89,
      journalEntry: 555,
      text: "Kodeks postępowania karnego (Dz. U. z 1997 r. Nr 89 poz. 555 - art. 535)",
    },
  ],
  referencedCourtCases: [
    { caseNumber: "III KK 257/02", judgmentIds: [243_456], generated: true },
  ],
  receiptDate: "2016-04-11",
  meansOfAppeal: "kasacja",
  judgmentResult: "ODDALONA",
  lowerCourtJudgments: [{ caseNumber: "II Ka 12/15" }],
  dissentingOpinions: [
    {
      textContent: "Zdanie odrębne co do kary.",
      authors: ["Dariusz Świecki"],
    },
  ],
} as const;

type PlCourtsJudgmentKey = keyof typeof PL_COURTS_JUDGMENT;

/** The keys the dump serves; the rest of the record is detail-only. */
const PL_COURTS_DUMP_KEYS = [
  "id",
  "courtType",
  "courtCases",
  "judgmentType",
  "judgmentDate",
  "judges",
  "textContent",
  "keywords",
  "division",
  "source",
  "courtReporters",
  "decision",
  "summary",
  "legalBases",
  "referencedRegulations",
  "referencedCourtCases",
  "receiptDate",
  "meansOfAppeal",
  "judgmentResult",
  "lowerCourtJudgments",
] as const satisfies readonly PlCourtsJudgmentKey[];

/** The keys the date-filtered search serves, which are fewer again. */
const PL_COURTS_SEARCH_KEYS = [
  "id",
  "href",
  "courtType",
  "courtCases",
  "judgmentType",
  "judgmentDate",
  "judges",
  "textContent",
  "keywords",
  "division",
] as const satisfies readonly PlCourtsJudgmentKey[];

const plCourtsListingRow = (
  keys: readonly PlCourtsJudgmentKey[],
): Record<string, unknown> =>
  Object.fromEntries(keys.map((key) => [key, PL_COURTS_JUDGMENT[key]]));

/** The per-judgment endpoint's whole answer, which wraps the record. */
const PL_COURTS_DETAIL_PAYLOAD = JSON.stringify({
  links: [{ rel: "self", href: PL_COURTS_JUDGMENT.href }],
  data: PL_COURTS_JUDGMENT,
});

const plCourtsDecision = (
  listingPart: "listing-dump" | "listing-search",
  keys: readonly PlCourtsJudgmentKey[],
): IngestionResult => {
  const listingRow = plCourtsListingRow(keys);
  return (
    buildPlDecision({
      listingItem: normalizeSaosDumpItem(listingRow),
      detail: normalizeSaosDumpItem({ ...PL_COURTS_JUDGMENT }),
      rawParts: {
        [listingPart]: JSON.stringify(listingRow),
        detail: PL_COURTS_DETAIL_PAYLOAD,
      },
    }) ?? panic("the pl-courts fixture did not build")
  );
};

/**
 * Built from the payloads directly rather than through the adapter's fetch
 * path: what these guards certify is the mapping from a stated field to the
 * row, and a stubbed transport only adds this publisher's request gate to
 * every run.
 */
export const plCourtsFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () =>
    await Promise.resolve(
      plCourtsDecision("listing-dump", PL_COURTS_DUMP_KEYS),
    ),
});

/**
 * The same decision as the reconciliation walk reaches it.
 *
 * A second fixture rather than a second part on the first: a row is named by
 * the dump or by the date-filtered search, so no one envelope holds both
 * listings, and a surface census has to read each from an envelope that
 * could exist.
 */
export const plCourtsSearchFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () =>
    await Promise.resolve(
      plCourtsDecision("listing-search", PL_COURTS_SEARCH_KEYS),
    ),
});

// ── PL SN fixture ────────────────────────────────────────

/** The listing row, as `searchOrzeczenia` states one. */
const PL_SN_LISTING_ROW = {
  sygnatura_sprawy: "I CSKP 40/26",
  data_wydania: "2026-06-10",
  forma_orzeczenia: "wyrok SN",
  id: "0l6YSZcBZvGrB8P_kR8N",
} as const;

/**
 * The detail response, carrying every field this proxy is known to label.
 * Each one is given a value, because a disposition is only exercised where
 * the decision built from the fixture can be checked for it.
 */
const PL_SN_DETAIL_PAYLOAD = JSON.stringify({
  success: true,
  message: null,
  messages: null,
  data: [
    {
      success: true,
      message: null,
      messages: null,
      data: {
        jednostka_obslugujaca_sprawe: "Izba Cywilna Wydział I",
        izby_sn: ["Izba Cywilna"],
        rodzaj_skladu_orzekajacego: "Skład 3-osobowy",
        sklad_orzekajacy: ["Jan Kowalski", "Anna Nowak"],
        sklad_orzekajacy_przewodniczacy: ["Jan Kowalski"],
        sklad_orzekajacy_sprawozdawca: ["Anna Nowak"],
        sklad_orzekajacy_wspolsprawozdawcy: ["Piotr Wiśniewski"],
        sklad_orzekajacy_autor_uzasadnienia: "Anna Nowak",
        zglaszajacy_zdanie_odrebne_orzeczenie: "Piotr Wiśniewski",
        zglaszajacy_zdanie_odrebne_uzasadnienie: "Piotr Wiśniewski",
        data_modyfikacji: "2026-06-20",
        ...PL_SN_LISTING_ROW,
      },
    },
  ],
});

/**
 * The detail payload the inventory reads, as the inner record the adapter
 * hands its own normalizer.
 */
const plSnDetailRecord = (): Record<string, unknown> => {
  const payload: unknown = JSON.parse(PL_SN_DETAIL_PAYLOAD);
  const inner = readPlSnEnvelope(payload);
  return isRecord(inner) ? inner : panic("the pl-sn fixture states no detail");
};

/**
 * Built from the payloads directly rather than through the adapter's fetch
 * path. What these guards certify is the mapping from a stated field to the
 * row, and driving a stubbed transport to reach it only added this publisher's
 * one-second request gate to every run. No document is supplied: no declared
 * field is stored through it, so the fixture states exactly what the inventory
 * reads.
 */
export const plSnFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () => {
    const built = await assemblePlSnDecision({
      item: { ...PL_SN_LISTING_ROW },
      detail: normalizePlSnDetail(plSnDetailRecord()),
      documentBytes: undefined,
      rawParts: {
        listing: JSON.stringify(PL_SN_LISTING_ROW),
        detail: PL_SN_DETAIL_PAYLOAD,
      },
    });
    return built.type === "unkeyable"
      ? panic("pl-sn fixture did not build")
      : built.decision;
  },
});

// ── CZ ÚS fixture ────────────────────────────────────────

/** One labelled row of the record card, in the court's own markup. */
const czUsCardRow = (label: string, value: string): string =>
  `<tr><td style="font-size:10pt;">${label}</td>` +
  `<td style="font-size:10pt;">${value}</td></tr>`;

/**
 * The record card, carrying every label this court is known to print and a
 * value in each.
 *
 * Every label filled because the conformance suite walks what the fixture
 * states: a cell left blank would declare a disposition nothing exercises.
 * The two judge rows repeat the court's own `<br/>` separator, which is what
 * turns one cell into the ordered list of dissenters.
 */
const CZ_US_RECORD_CARD = `<!DOCTYPE html><html><body>
  <table id="tableDocumentHeader"><tr><td>Soudce zpravodaj</td></tr></table>
  <table class='recordCardTable'>${[
    czUsCardRow(
      "Identifikátor evropské judikatury",
      "ECLI:CZ:US:2026:Pl.US.9.26.1",
    ),
    czUsCardRow("Název soudu", "Ústavní soud České republiky"),
    czUsCardRow("Spisová značka", "Pl.ÚS 9/26"),
    czUsCardRow("Paralelní citace (Sbírka zákonů)", "120/2026 Sb."),
    czUsCardRow(
      "Paralelní citace (Sbírka nálezů a usnesení)",
      "N 12/90 SbNU 101",
    ),
    czUsCardRow("Populární název", "Lhůta pro podání správní žaloby"),
    czUsCardRow("Datum rozhodnutí", "3. 2. 2026"),
    czUsCardRow("Datum vyhlášení", "10. 2. 2026"),
    czUsCardRow("Datum podání", "4. 6. 2025"),
    czUsCardRow("Datum zpřístupnění", "12. 2. 2026"),
    czUsCardRow("Forma rozhodnutí", "Nález"),
    czUsCardRow("Typ řízení", "O zrušení zákonů a jiných právních předpisů"),
    czUsCardRow("Význam", "1"),
    czUsCardRow("Navrhovatel", "SKUPINA SENÁTORŮ"),
    czUsCardRow("Dotčený orgán", "POSLANECKÁ SNĚMOVNA PARLAMENTU ČR"),
    czUsCardRow("Soudce zpravodaj", "Nováková Jana"),
    czUsCardRow("Napadený akt", "zákon; 150/2002 Sb.; § 72"),
    czUsCardRow("Typ výroku", "vyhověno<br/>zamítnuto"),
    czUsCardRow(
      "Dotčené ústavní zákony a mezinárodní smlouvy",
      "2/1993 Sb./Sb.m.s., čl. 36 odst.1",
    ),
    czUsCardRow("Ostatní dotčené předpisy", "150/2002 Sb., § 72"),
    czUsCardRow("Odlišné stanovisko", "Dvořák Petr<br/>Svobodová Eva"),
    czUsCardRow("Předmět řízení", "právo na soudní a jinou právní ochranu"),
    czUsCardRow("Věcný rejstřík", "žaloba<br/>lhůta"),
    czUsCardRow("Jazyk rozhodnutí", "Čeština"),
    czUsCardRow("Poznámka", "Nález byl vyhlášen ve Sbírce zákonů."),
    czUsCardRow(
      "URL adresa",
      "https://nalus.usoud.cz:443/Search/GetText.aspx?sz=Pl-9-26_1",
    ),
  ].join("")}</table>
</body></html>`;

/** The document page, whose hidden labels key the decision's identity. */
const CZ_US_TEXT_PAGE = `<html><body>
  <span id="lblRegistrySign">Pl.ÚS 9/26 ze dne 3. 2. 2026</span>
  <span id="lblDecisionForm">Nález</span>
  <span id="lblParallelQuotation">120/2026 Sb.</span>
  <span id="lblPopularName">Lhůta pro podání správní žaloby</span>
  <input name="registrySignHidden" value="Pl.ÚS 9/26 #1 ze dne 3. 2. 2026" />
  <table class="DocContent"><tr><td>
    ${"Ústavní soud rozhodl v plénu o návrhu skupiny senátorů. ".repeat(6)}
  </td></tr></table>
</body></html>`;

/**
 * The abstract page, which this court serves at an address of its own and
 * which carries the two supplementary texts it writes about a decision.
 */
const CZ_US_ABSTRACT_PAGE = `<html><body>
  <table class="abstractContent"><tr><td>
    ${"Ústavní soud zrušil ustanovení o lhůtě pro podání správní žaloby. ".repeat(4)}
  </td></tr></table>
  <table class="legalSentenceContent"><tr><td>
    ${"Lhůta pro podání žaloby nesmí být kratší, než je nezbytné pro přípravu žaloby. ".repeat(4)}
  </td></tr></table>
</body></html>`;

const CZ_US_LISTING_ROW = {
  caseNumber: "Pl.ÚS 9/26",
  counter: 1,
  quarantineId: "cz-us-inventory-fixture",
  quarantineRepairIds: [],
  listingHtml: "<tr><td>Pl.ÚS 9/26 #1</td></tr>",
  sourceDocumentId: "nalus-record:900026",
  nalusRecordId: "900026",
  sourceUrl: "https://nalus.usoud.cz/Search/GetText.aspx?sz=Pl-9-26_1",
  sz: "Pl-9-26_1",
  ecli: "ECLI:CZ:US:2026:Pl.US.9.26.1",
} as const satisfies ListedDecision;

export const czUsFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () =>
    await Promise.resolve(
      buildCzUsDecision({
        listed: { ...CZ_US_LISTING_ROW },
        textHtml: CZ_US_TEXT_PAGE,
        recordCard: { type: "read", html: CZ_US_RECORD_CARD },
        abstractHtml: CZ_US_ABSTRACT_PAGE,
      }) ?? panic("cz-us fixture did not build"),
    ),
});

// ── SK courts fixture ────────────────────────────────────

/** The court entry both `sud` and `povodnySud` are served as. */
const skCourtEntry = (registreGuid: string, nazov: string) => ({
  registreGuid,
  nazov,
  adresaString: "Záhradnícka 10, 81244 Bratislava",
  suradnice: { zemepisnaDlzka: "17.122962", zemepisnaSirka: "48.152538" },
});

/**
 * The listing row, as `BaseRozhodnutie` declares one.
 *
 * Every property of the schema carries a value, the registry columns a live
 * listing happens to omit included: a disposition is only exercised where the
 * envelope states the field it decides about.
 */
const SK_COURTS_LISTING_ROW = {
  guid: "23ea32af-a671-41a6-b853-72f5d52b820c:26b85db6-ff6b-44ff-8fa4-a21c89805371",
  formaRozhodnutia: "Rozsudok",
  povaha: ["Zmeňujúce"],
  sud: skCourtEntry("sud_105", "Mestský súd Bratislava IV"),
  sudca: { registreGuid: "sudca_1600", meno: "JUDr. Anton Mihalovits" },
  identifikacneCislo: "1191896318",
  spisovaZnacka: "B1-7C/221/1991",
  datumVydania: "20.06.1997",
  zvyraznenie: [],
};

/** The per-decision record, as `Rozhodnutie` declares one. */
const SK_COURTS_DETAIL_RECORD = {
  ...SK_COURTS_LISTING_ROW,
  ecli: "ECLI:SK:OSBA1:1997:1191896318.4",
  oblast: ["Občianske právo"],
  podOblast: ["Ostatné"],
  odkazovanePredpisy: [
    {
      nazov: "/SK/ZZ/1991/87",
      url: "https://www.slov-lex.sk/pravne-predpisy/SK/ZZ/1991/87",
    },
  ],
  dokument: {
    name: "Rozsudok_7C-221-1991.pdf",
    fileExtension: "PDF",
    size: 95_553,
    url: "https://obcan.justice.sk/content/public/item/26b85db6-ff6b-44ff-8fa4-a21c89805371",
    id: 4_112_887,
  },
  updateDate: "26.09.2023",
  povodnySud: skCourtEntry("sud_102", "Mestský súd Bratislava I"),
  povodnaSpisovaZnacka: "7C/221/1991",
};

export const skCourtsFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () =>
    await Promise.resolve(
      assembleSkCourtsDecision({
        item: { ...SK_COURTS_LISTING_ROW },
        detail: { ...SK_COURTS_DETAIL_RECORD },
      }) ?? panic("sk-courts fixture did not build"),
    ),
});

// ── SK ÚS fixture ────────────────────────────────────────

/**
 * The search row, carrying every key this service is known to send.
 *
 * All forty-six filled, because a disposition is only exercised where the
 * decision built from the fixture can be checked for it, and the service
 * sends the same key set for every corpus it serves: a key that is empty on
 * a decision is filled on a collection entry, and both reach the adapter
 * through this one reader.
 */
const SK_US_LISTING_ROW = {
  docType: "USSR_DECISION",
  content: null,
  title: "Rozhodnutie - Nález",
  index: 0,
  documentId: "11111111-2222-4333-8444-555555555555",
  contentType: "application/pdf",
  extension: null,
  size: null,
  mkDocumentType: "Rozhodnutie - Nález",
  mkDateOfDecision: "07/29/2021 00:00:00",
  mkRSAPNumberOfFile: "III. ÚS 425/2021",
  mkRVPNumberOfFile: "1448/2020",
  mkECLI: "ECLI:SK:USSR:2021:3.US.425.2021.1",
  mkDateOfLegalForce: "07/31/2021 00:00:00",
  mkPublicationDate: "08/05/2021 00:00:00",
  mkFormOfDecision: "Nález",
  mkTypeOfDecision: ["Nález"],
  mkTypeOfProceeding: "konanie o ústavných sťažnostiach",
  mkTypeOfNegotiation: ["Neverejné zasadnutie"],
  mkDecisionInTermsOf: ["čl. 127 ods. 1 ústavy"],
  mkDecisionInTermsOfForSort: "čl. 127 ods. 1 ústavy",
  mkResultOfNegotiation: ["vyhovuje"],
  mkCause: ["porušenie základného práva"],
  mkJudgeReporter: "Martin Vernarský",
  mkDifferentView: "Odlišné stanovisko iné",
  mkWordRegister: ["základné práva a slobody"],
  mkMaterialRegister: ["právo na súdnu ochranu"],
  mkComplainedLegalRegulation: "301/2005 Z. z.",
  mkClarificationOfLegalRegulation: "arbitrárnosť rozhodnutia",
  mkFileReference: ["1448/2020"],
  mkReferences: ["2196/2020"],
  mkTypeOfProposer: "Fyzická osoba",
  mkAffectedLegalRegulation: "460/1992 Zb.",
  mkUnderage: "nie",
  mkIncludeToZnaU: true,
  mkEntryDate: "06/30/2020 00:00:00",
  mkFormOfEntry: "písomné podanie",
  mkTypeOfEntry: "ústavná sťažnosť",
  mkParentIdDecision: "Nalez",
  mkLawReportsNumber: "43",
  mkVolumeOfLawReports: "2021",
  mkYearOfLawReports: 2021,
  mkTimePeriodZNaU: "II. polrok",
  mkClauseTitle: "Právo na súdnu ochranu",
  mkClauseText:
    "Všeobecný súd musí svoje rozhodnutie odôvodniť tak, aby bolo preskúmateľné.",
  mkWebTitle: "Nález III. ÚS 425/2021",
};

/**
 * The facet counts of the docket on its decision day, which is the only
 * form these index fields are ever served in.
 */
const SK_US_FACETS = JSON.stringify({
  documents: [SK_US_LISTING_ROW],
  numFound: 1,
  facetCount: {
    mkDifferentViewJudges: { "Peter Straka": 1 },
    mkDefendant: { "Okresný súd Košice II": 1 },
    mkPublicDefendant: { "Okresný súd Košice II": 1 },
    mkViolator: { "Okresný súd Košice II": 1 },
    mkFormOfProposer: { "Fyzická osoba": 1 },
    mkKindOfOtherProposer: { "Generálny prokurátor SR": 1 },
    mkFileNumberOfDefendantProceeding: { "5T/12/2019": 1 },
  },
});

/** The docket file, whose header states when the petition arrived. */
const SK_US_COURT_FILE = JSON.stringify({
  documents: [
    {
      docType: "USSR_COURTFILE",
      documentId: "99999999-8888-4777-8666-555555555555",
      mkRVPNumberOfFile: "1448/2020",
      mkEntryDate: "06/30/2020 00:00:00",
      mkReferences: ["2196/2020"],
    },
    SK_US_LISTING_ROW,
  ],
  numFound: 2,
});

/** The two rosters the decision's judge fields are drawn from. */
const SK_US_CODELIST = JSON.stringify({
  codelist: {
    mkJudgeReporter: ["Martin Vernarský", "Peter Straka"],
    mkDifferentViewJudges: ["Martin Vernarský", "Peter Straka"],
  },
});

/**
 * The document as the court renders it, with one anonymized run.
 *
 * The run is a black-on-black span over non-breaking spaces, which is how
 * this court redacts: the fixture carries the shape rather than any hidden
 * words, because there are none to carry.
 */
const SK_US_DOCUMENT_XHTML =
  `<?xml version="1.0" encoding="UTF-8"?><html><body><div>` +
  `<span style="font-size: 21px; ">NÁLEZ<br/><br/></span>` +
  `<span style="font-size: 12px; ">Ústavný súd Slovenskej republiky v senáte o ústavnej sťažnosti sťažovateľa <br/>` +
  `</span><span style="color: #000000; background-color: #000000; font-size: 12px; ">${"&nbsp;".repeat(
    8,
  )}</span>` +
  `<span style="font-size: 12px; "> takto <br/><br/>rozh od ol :  <br/><br/>` +
  `Základné právo sťažovateľa na súdnu ochranu porušené bolo. <br/><br/>` +
  `O d ôvod n eni e:  <br/><br/>` +
  `Ústavný súd preskúmal napadnuté rozhodnutie a dospel k záveru, že je arbitrárne. <br/><br/>` +
  `Pou čen i e :  Proti tomuto nálezu nemožno podať opravný prostriedok. <br/><br/>` +
  `V Košiciach 29. júla 2021 <br/><br/>Martin Vernarský <br/>predseda senátu</span></div></body></html>`;

/** A payload that opens like a PDF; its body is not a parseable one. */
const SK_US_DOCUMENT_FILE = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj\n<<>>\n",
);

/** The source this fixture's decision is stored under; it prefixes its keys. */
const SK_US_SOURCE_ID = "sk-us-inventory-fixture";

/**
 * Built through the adapter's own fetch path, because what this adapter
 * stores is decided there: five responses per decision, four of them
 * fetched from endpoints the builder chooses between.
 *
 * The envelope is then closed over its binary part the way the pipeline
 * closes it, through the same derivation, so the guards read the envelope a
 * stored row holds rather than one this helper invented.
 */
export const skUsFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () => {
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = ((): string | Uint8Array => {
        if (url.pathname === "/o/v1/dms/content") {
          return JSON.stringify({
            content: Buffer.from(SK_US_DOCUMENT_XHTML).toString("base64"),
          });
        }
        if (url.pathname === "/o/v1/dms/search") {
          return SK_US_FACETS;
        }
        if (url.pathname.startsWith("/o/v1/dms/file/")) {
          return SK_US_COURT_FILE;
        }
        if (url.pathname === "/o/v1/codelist/decision") {
          return SK_US_CODELIST;
        }
        return SK_US_DOCUMENT_FILE;
      })();
      return await Promise.resolve(
        new Response(body, {
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const built = await buildSkUsDecision({ ...SK_US_LISTING_ROW });
    if (built.type !== "built") {
      return panic(`sk-us fixture did not build: ${built.type}`);
    }
    const { decision } = built;
    const objects = Object.fromEntries(
      Object.entries(decision.sourceRawObjects ?? {}).map(
        ([part, { bytes, contentType }]) => [
          part,
          sourceBinaryRef({
            family: RAW_SOURCE_FAMILY.CASE_LAW,
            sourceId: SK_US_SOURCE_ID,
            bytes,
            contentType,
          }),
        ],
      ),
    );
    return {
      ...decision,
      sourceRaw: withSourceRawObjects(decision.sourceRaw ?? "", objects),
    };
  },
});

/** The tribunal adapters this helper states a decision for. */
export type AtRisFixtureAdapter = keyof typeof AT_RIS_SOURCES;

/**
 * The source definition each tribunal's adapter is built from, so a fixture
 * is driven through the same code its crawl runs.
 */
export const AT_RIS_SOURCES = {
  [ADAPTER_KEYS.AT_COURTS]: AT_COURTS_SOURCE,
  [ADAPTER_KEYS.AT_VFGH]: AT_VFGH_SOURCE,
  [ADAPTER_KEYS.AT_VWGH]: AT_VWGH_SOURCE,
  [ADAPTER_KEYS.AT_BVWG]: AT_BVWG_SOURCE,
  [ADAPTER_KEYS.AT_LVWG]: AT_LVWG_SOURCE,
  [ADAPTER_KEYS.AT_ASYLGH]: AT_ASYLGH_SOURCE,
  [ADAPTER_KEYS.AT_UBAS]: AT_UBAS_SOURCE,
  [ADAPTER_KEYS.AT_UVS]: AT_UVS_SOURCE,
  [ADAPTER_KEYS.AT_VERG]: AT_VERG_SOURCE,
  [ADAPTER_KEYS.AT_UMSE]: AT_UMSE_SOURCE,
  [ADAPTER_KEYS.AT_BKS]: AT_BKS_SOURCE,
} as const satisfies Record<string, AtRisSourceDefinition>;

// ── Austrian RIS fixtures ────────────────────────────────

/**
 * One decision per Austrian tribunal, stated the way its own application
 * states one.
 *
 * Built from the application's declared profile rather than written out
 * eleven times: the listing item carries a value at every field path the
 * profile names, and the document prints a section for every content type it
 * names, so a field added to an application's vocabulary without a value here
 * fails this suite by name instead of going unexercised.
 */
const AT_RIS_DOCUMENT_ID = {
  "at-courts": "JJT_20260115_OGH0002_0010OB00001_26A0000_000",
  "at-vfgh": "JFT_20260115_26V00001_00",
  "at-vwgh": "JWT_2026010012_20260115L00",
  "at-bvwg": "BVWGT_20260115_W221_2345678_1_00",
  "at-lvwg": "LVWGT_WI_20260115_VGW_001_001_2026_00",
  "at-asylgh": "ASYLGHT_20131211_E1_436234_1_2013_00",
  "at-ubas": "UBAST_20080627_319_718_1_III_12_08_00",
  "at-uvs": "JUT_WI_20131217_06FM463_2013_00",
  "at-verg": "VERGT_20131219_N_0117_BVA_11_2013_00",
  "at-umse": "UMSET_20131202_US_4B_2013_8_00",
  "at-bks": "BKST_20131211_611_997_0001_BKS_2013_00",
} as const satisfies Record<AtRisFixtureAdapter, string>;

const AT_RIS_COURT = "Oberster Gerichtshof";
const AT_RIS_CASE_NUMBER = "1 Ob 1/26a";
const AT_RIS_SECOND_CASE_NUMBER = "1 Ob 2/26y";
const AT_RIS_DECISION_DATE = "2026-01-15";
const AT_RIS_HEADNOTE_DOCUMENT_ID =
  "JJR_20260115_OGH0002_0010OB00001_26A0000_001";

/** The values the fixture states for the fields any application may carry. */
const AT_RIS_BRANCH_VALUES: Readonly<Record<AtRisBranchField, unknown>> = {
  Anfechtung: "Anfechtung beim Verwaltungsgerichtshof",
  Anmerkung: "Hinweis auf eine spätere Änderung der Rechtslage",
  Beachte: "Beachte auch die Entscheidung desselben Tages",
  Bezug: { item: ["W221 2345678-1"] },
  Bundesland: "Wien",
  DokumentnummerDesVwGH: "JWT_2026010012_20260115L00",
  DokumentnummerTyp: "L",
  EntscheidendeBehoerde: AT_RIS_COURT,
  Entscheidungsart: "Erkenntnis",
  Entscheidungstexte: {
    item: {
      Geschaeftszahl: AT_RIS_CASE_NUMBER,
      Dokumenttyp: "Text",
      Entscheidungsdatum: AT_RIS_DECISION_DATE,
      Dokumentnummer: "JJT_20260115_OGH0002_0010OB00001_26A0000_000",
    },
  },
  Fachgebiete: { item: ["Arbeitsrecht"] },
  Fundstelle: "ÖJZ 2026/12",
  Gericht: AT_RIS_COURT,
  Gerichtsentscheidungen: { item: ["VwGH 2020/01/0001"] },
  HinweisAufStammrechtssatz: "GRS wie Ra 2018/14/0440 B 21. Jänner 2020 RS 1",
  Indizes: { item: ["10/01 Bundes-Verfassungsgesetz (B-VG)"] },
  Kurzbezeichnung: "Kraftwerk Riefensberg",
  Kurzinformation: "Kurzinformation zum Verfahrensgegenstand",
  Leitsatz: "Zur Auslegung des Schadenersatzrechts bei verspäteter Leistung.",
  Rechtsgebiete: { item: ["Zivilrecht"] },
  Rechtssatzkette:
    "https://ogd.ris.bka.gv.at/VwghRechtssatzkette.wxe?Abfrage=Vwgh",
  Rechtssatznummer: "1",
  Rechtssatznummern: { item: ["RS0135001"] },
  Sammlungsnummer: "VfSlg 20.000",
  Stammrechtssatznummer: "JWR_2018140440_20200121L01",
  Textnummern: { item: ["JJT_20260115_OGH0002_0010OB00001_26A0000_000"] },
  Veroeffentlichungen: "ZVB 2026/5",
  Verfasser: "Kammer III",
  Vorverfahren: "N/0001-BVA/01/2026",
};

/** The heading this publisher prints over each of its document sections. */
const AT_RIS_DOCUMENT_HEADING: Readonly<Record<AtRisDocumentField, string>> = {
  begruendung: "Begründung",
  betreff: "Betreff",
  ecli: "European Case Law Identifier",
  entscheidungsdatum: "Entscheidungsdatum",
  entscheidungstexte: "Entscheidungstexte",
  gericht: "Gericht",
  gz: "Geschäftszahl",
  hinweisstrs: "Hinweis auf Stammrechtssatz",
  kopf: "Kopf",
  kurzbezeichnung: "Kurzbezeichnung",
  leitsatz: "Leitsatz",
  norm: "Norm",
  organ: "Entscheidende Behörde",
  rechtlichebeurteilung: "Rechtliche Beurteilung",
  rechtssatz: "Rechtssatz",
  rechtssatznummer: "Rechtssatznummer",
  spruch: "Spruch",
  strs: "Stammrechtssatz",
  text: "Text",
};

const AT_RIS_DOCUMENT_TEXT: Readonly<Record<AtRisDocumentField, string>> = {
  begruendung:
    "Die Revision ist zulässig, weil die Rechtsprechung zur Verjährung uneinheitlich ist.",
  betreff: "Verjährung von Schadenersatzansprüchen; Beginn der Frist.",
  ecli: "ECLI:AT:OGH0002:2026:0010OB00001.26A.0115.000",
  entscheidungsdatum: AT_RIS_DECISION_DATE,
  entscheidungstexte: "1 Ob 1/26a; 1 Ob 2/26y",
  gericht: AT_RIS_COURT,
  gz: AT_RIS_CASE_NUMBER,
  hinweisstrs: "GRS wie Ra 2018/14/0440 B 21. Jänner 2020 RS 1",
  kopf: "Der Oberste Gerichtshof hat als Revisionsgericht durch den Senatspräsidenten in der Rechtssache der klagenden Partei entschieden.",
  kurzbezeichnung: "Kraftwerk Riefensberg",
  leitsatz:
    "Zur Auslegung des Schadenersatzrechts bei verspäteter Leistung; die Frist beginnt mit Kenntnis des Schadens.",
  norm: "ABGB §1295",
  organ: AT_RIS_COURT,
  rechtlichebeurteilung:
    "Die Revision ist aus den vom Berufungsgericht genannten Gründen nicht zulässig.",
  rechtssatz:
    "Der Beginn der Verjährungsfrist setzt die Kenntnis von Schaden und Schädiger voraus.",
  rechtssatznummer: "RS0135001",
  spruch: "Der Revision wird nicht Folge gegeben.",
  strs: "Der Beginn der Verjährungsfrist setzt die Kenntnis von Schaden und Schädiger voraus.",
  text: "Das Erstgericht wies das Klagebegehren ab. Das Berufungsgericht bestätigte diese Entscheidung.",
};

/** Write a value at the element path the publisher's schema spells. */
const atPath = (
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void => {
  let current = target;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    const group = isRecord(next) ? next : {};
    current[key] = group;
    current = group;
  }
  const leaf = path.at(-1);
  if (leaf === undefined) {
    panic("a RIS fixture field has no element name");
  }
  current[leaf] = value;
};

const atRisDocumentUrl = (
  application: string,
  documentId: string,
  extension: string,
): string =>
  `https://ogd.ris.bka.gv.at/Dokumente/${application}/${documentId}/${documentId}.${extension}`;

/** The listing item, carrying a value at every field path the profile names. */
const atRisListingItem = (
  adapter: AtRisFixtureAdapter,
): Record<string, unknown> => {
  const { application, branch } = AT_RIS_APPLICATIONS[adapter];
  const documentId = AT_RIS_DOCUMENT_ID[adapter];
  const metadata: Record<string, unknown> = {};
  atPath(metadata, ["Technisch", "ID"], documentId);
  atPath(metadata, ["Technisch", "Applikation"], application);
  atPath(metadata, ["Technisch", "Organ"], AT_RIS_COURT);
  atPath(metadata, ["Technisch", "Einbringer"], "LG Leoben");
  atPath(metadata, ["Technisch", "ImportTimestamp"], { "@xsi:nil": "true" });
  atPath(metadata, ["Allgemein", "Veroeffentlicht"], "2026-01-20");
  atPath(metadata, ["Allgemein", "Geaendert"], "2026-01-21");
  atPath(
    metadata,
    ["Allgemein", "DokumentUrl"],
    `https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=${application}&Dokumentnummer=${documentId}`,
  );
  atPath(metadata, ["Judikatur", "Dokumenttyp"], "Text");
  atPath(metadata, ["Judikatur", "Geschaeftszahl"], {
    item: [AT_RIS_CASE_NUMBER, AT_RIS_SECOND_CASE_NUMBER],
  });
  atPath(metadata, ["Judikatur", "Normen"], {
    item: ["ABGB §1295", "ZPO §502"],
  });
  atPath(metadata, ["Judikatur", "Entscheidungsdatum"], AT_RIS_DECISION_DATE);
  atPath(
    metadata,
    ["Judikatur", "Schlagworte"],
    "Schadenersatz, Verjährung, Vertragsrecht",
  );
  atPath(
    metadata,
    ["Judikatur", "EuropeanCaseLawIdentifier"],
    "ECLI:AT:OGH0002:2026:0010OB00001.26A.0115.000",
  );
  atPath(
    metadata,
    ["Judikatur", "GesamteEntscheidungUrl"],
    `https://ogd.ris.bka.gv.at/JudikaturEntscheidung.wxe?Abfrage=${application}&IncludeSelf=True`,
  );
  atPath(
    metadata,
    ["Judikatur", "EntscheidungstextUrl"],
    `https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=${application}&Dokumentnummer=${documentId}`,
  );
  atPath(
    metadata,
    ["Judikatur", "RechtssaetzeUrl"],
    `https://ogd.ris.bka.gv.at/JudikaturEntscheidung.wxe?Abfrage=${application}&IncludeSelf=False`,
  );
  for (const field of branch) {
    atPath(
      metadata,
      ["Judikatur", application, atRisBranchElement(field)],
      AT_RIS_BRANCH_VALUES[field],
    );
  }
  return {
    Data: {
      Metadaten: metadata,
      Dokumentliste: {
        ContentReference: [
          {
            ContentType: "MainDocument",
            Name: "Hauptdokument",
            Urls: {
              ContentUrl: ["Xml", "Html", "Rtf", "Pdf"].map((dataType) => ({
                DataType: dataType,
                Url: atRisDocumentUrl(
                  application,
                  documentId,
                  dataType.toLowerCase(),
                ),
              })),
            },
          },
          {
            // A document that embeds an image is listed as several
            // references, which is the shape that made every such decision
            // listing-only while the reader expected one.
            ContentType: "EmbeddedAttachment",
            Name: "Anlage 1",
            Urls: {
              ContentUrl: {
                DataType: "Png",
                Url: atRisDocumentUrl(application, documentId, "1.png"),
              },
            },
          },
        ],
      },
    },
  };
};

/** The document, printing a section for every content type the profile names. */
const atRisDocumentXml = (adapter: AtRisFixtureAdapter): string => {
  const sections = AT_RIS_APPLICATIONS[adapter].document
    .map(
      (field) =>
        `<ueberschrift typ="titel">${AT_RIS_DOCUMENT_HEADING[field]}</ueberschrift>` +
        `<absatz ct="${field}">${AT_RIS_DOCUMENT_TEXT[field]}</absatz>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><risdok><metadaten/><nutzdaten>` +
    `<kzinhalt><absatz>www.ris.bka.gv.at</absatz></kzinhalt>` +
    `${sections}</nutzdaten></risdok>`
  );
};

/**
 * The headnote answer for this decision, in the shape the search endpoint
 * returns one: a document of its own that names the decision it belongs to.
 */
const atRisHeadnoteListing = (adapter: AtRisFixtureAdapter): string => {
  const { application } = AT_RIS_APPLICATIONS[adapter];
  const documentId = AT_RIS_DOCUMENT_ID[adapter];
  return JSON.stringify({
    OgdSearchResult: {
      OgdDocumentResults: {
        Hits: { "@pageNumber": "1", "@pageSize": "100", "#text": "1" },
        OgdDocumentReference: {
          Data: {
            Metadaten: {
              Technisch: {
                ID: AT_RIS_HEADNOTE_DOCUMENT_ID,
                Applikation: application,
                Organ: AT_RIS_COURT,
              },
              Allgemein: {
                DokumentUrl: `https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=${application}&Dokumentnummer=${AT_RIS_HEADNOTE_DOCUMENT_ID}`,
              },
              Judikatur: {
                Dokumenttyp: "Rechtssatz",
                Geschaeftszahl: { item: AT_RIS_CASE_NUMBER },
                Entscheidungsdatum: AT_RIS_DECISION_DATE,
                EuropeanCaseLawIdentifier:
                  "ECLI:AT:OGH0002:2026:0010OB00001.26A.0115.001",
                EntscheidungstextUrl: `https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=${application}&Dokumentnummer=${documentId}`,
              },
            },
            Dokumentliste: {
              ContentReference: {
                ContentType: "MainDocument",
                Urls: {
                  ContentUrl: {
                    DataType: "Xml",
                    Url: atRisDocumentUrl(
                      application,
                      AT_RIS_HEADNOTE_DOCUMENT_ID,
                      "xml",
                    ),
                  },
                },
              },
            },
          },
        },
      },
    },
  });
};

export const atRisFixture = (
  adapter: AtRisFixtureAdapter,
): EnrolledAdapterFixture => ({
  buildDecision: async () =>
    await Promise.resolve(
      assembleAtRisDecision(
        AT_RIS_SOURCES[adapter],
        atRisListingItem(adapter),
        {
          documentXml: atRisDocumentXml(adapter),
          headnoteListing: atRisHeadnoteListing(adapter),
        },
      ),
    ),
});

// ── Findok fixture ───────────────────────────────────────

const AT_FINDOK_STAMM_NR = 152_649;
const AT_FINDOK_DOCUMENT_ID = "ffa6f670-dc36-42cc-ae37-52683327a048";
const AT_FINDOK_CASE_NUMBER = "RV/2100968/2026";

/** The manifest, as the ministry serves one, holding this decision's row. */
const AT_FINDOK_MANIFEST = JSON.stringify({
  generierungsdatum: "18.09.2026 06:17",
  data: [
    {
      stammNr: AT_FINDOK_STAMM_NR,
      pathZip: `152/${AT_FINDOK_STAMM_NR}/${AT_FINDOK_STAMM_NR}.zip`,
      pathPdf: `152/${AT_FINDOK_STAMM_NR}/${AT_FINDOK_STAMM_NR}.1.pdf`,
      dokumenttyp: "Bescheidbeschwerde - Einzel - Erkenntnis",
      behoerde: "BFG",
      appdat: "10.09.2026",
      gz: AT_FINDOK_CASE_NUMBER,
      titel:
        "Energiekrisenbeitrag Strom: keine verfassungsrechtlichen Bedenken",
      gueltigAb: "01.01.2026",
      inFindokSeitDate: "2026-09-17T14:15:26.3717",
      inFindokSeit: "17.09.2026 02:15:26",
      gueltig: true,
      dokumentId: AT_FINDOK_DOCUMENT_ID,
    },
  ],
});

/** The envelope both archive entries share. */
const findokEnvelope = (): string =>
  `<Grundk><appdat>10.09.2026</appdat><appdatbis>31.12.7999</appdatbis>` +
  `<av_veroeffentlicht>1</av_veroeffentlicht><behoerde>BFG</behoerde>` +
  `<betreff>Energiekrisenbeitrag Strom: keine verfassungsrechtlichen Bedenken</betreff>` +
  `<doktyptxt>Bescheidbeschwerde - Einzel - Erkenntnis</doktyptxt>` +
  `<ecli>ECLI:AT:BFG:2026:RV.2100968.2026</ecli>` +
  `<erstfass>${AT_FINDOK_CASE_NUMBER}</erstfass><fsgnr>[1]</fsgnr>` +
  `<gid>d2c8016a-7c61-4607-9b46-17c3b6a732be_1_01.01.1970</gid>` +
  `<gz>${AT_FINDOK_CASE_NUMBER}</gz>` +
  `<lastchangedat>17.09.2026 02:15:26</lastchangedat>` +
  `<matbez_erf_sub><matbez_erf>Steuer</matbez_erf></matbez_erf_sub>` +
  `<matnr_erf_sub><matnr_erf>10</matnr_erf></matnr_erf_sub>` +
  `<ngesamt_erf_sub><ngesamt_erf>§ 1 Abs. 1 EKBSG</ngesamt_erf></ngesamt_erf_sub>` +
  `<stammnr>${AT_FINDOK_STAMM_NR}</stammnr>` +
  `<uebersex_net_sub><uebersex_net>Entscheidungsgründe</uebersex_net></uebersex_net_sub>` +
  `<vadat>17.09.2026 02:15:26</vadat></Grundk>`;

const findokSegmentBookkeeping = (): string =>
  `<dok_fassungsnr>1</dok_fassungsnr><dokformat>text/xhtml</dokformat>` +
  `<fsgnr>[1]</fsgnr><gid>dce662f0-f271-4538-8adc-9bcbc0cd9a2a_1</gid>` +
  `<id_multifassung>dce662f0-f271-4538-8adc-9bcbc0cd9a2a</id_multifassung>` +
  `<inkraftvon>01.01.1970</inkraftvon>` +
  `<lastchangedat>17.09.2026 02:15:26</lastchangedat>` +
  `<neuzdat>17.09.2026 02:15:26</neuzdat><segbez>Textbeginn</segbez>` +
  `<segnr2>1</segnr2>`;

const AT_FINDOK_DECISION_XHTML =
  "&lt;html&gt;&lt;body&gt;&lt;h1&gt;IM NAMEN DER REPUBLIK&lt;/h1&gt;" +
  "&lt;p&gt;Das Bundesfinanzgericht hat über die Bescheidbeschwerde erkannt.&lt;/p&gt;" +
  "&lt;p&gt;Die Beschwerde wird als unbegründet abgewiesen.&lt;/p&gt;" +
  "&lt;/body&gt;&lt;/html&gt;";

const AT_FINDOK_DECISION_XML =
  `<?xml version="1.0" encoding="UTF-8"?><Segmente><Segment>${findokEnvelope()}` +
  `<Segk>${findokSegmentBookkeeping()}<txt>${AT_FINDOK_DECISION_XHTML}</txt>` +
  `</Segk></Segment></Segmente>`;

const AT_FINDOK_HEADNOTE_XML =
  `<?xml version="1.0" encoding="UTF-8"?><Segmente><Segment>${findokEnvelope()}` +
  `<Segk>${findokSegmentBookkeeping()}<rsnr>1</rsnr>` +
  `<ngesamt_sub><ngesamt>§ 3 Abs. 1 EKBSG</ngesamt></ngesamt_sub>` +
  `<txtascii>Der Energiekrisenbeitrag Strom begegnet keinen verfassungsrechtlichen Bedenken.</txtascii>` +
  `</Segk></Segment></Segmente>`;

export const atFindokFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () => {
    const manifest = parseFindokManifest("bfg", AT_FINDOK_MANIFEST);
    const item = manifest.items.at(0);
    if (item === undefined) {
      panic("the at-findok fixture manifest states no row");
    }
    return await Promise.resolve(
      assembleAtFindokDecision(
        { collection: "bfg", item },
        {
          documentXml: AT_FINDOK_DECISION_XML,
          headnoteXml: AT_FINDOK_HEADNOTE_XML,
        },
      ),
    );
  },
});

// ── HU BHGY fixture ──────────────────────────────────────

/**
 * One listing row as `AnonimizaltHatarozat/Search` states it, with every field
 * the search labels filled — the three the inventory excludes included, so the
 * guards exercise the exclusions rather than only the stored fields.
 *
 * `Azonosito` is the docket in the collection's own spelling, which drops the
 * thousands dot and the panel numeral the decision file prints.
 */
const HU_BHGY_LISTING_ROW = {
  Azonosito: "Gfv.30197/2024/4",
  MeghozoBirosag: "Kúria",
  Kollegium: "gazdasági",
  JogTerulet: "gazdasági jog",
  KapcsolodoHatarozatok: [
    {
      KapcsolodoUgyszam: "5.Gf.40.014/2023/15",
      KapcsolodoBirosag: "Szegedi Törvényszék",
    },
  ],
  Jogszabalyhelyek:
    "2016. évi CXXX. törvény a polgári perrendtartásról 409. § (2) - 2024-01-01",
  HatarozatEve: 2025,
  Szoveg: null,
  Rezume:
    "A felülvizsgálat engedélyezése iránti kérelemnek központi jelentőségű tartalmi eleme a jogértelmezést igénylő jogkérdés megfogalmazása.",
  RezumeSzovegKornyezet: null,
  EgyediAzonosito: "K-GJ-2025-179",
  IndexelesIdeje: "2025-10-10T10:23:45.051584+02:00",
  NemHivatkozhatoSzoveg: null,
  IndexId: "eb8acbdd-45e9-467f-b6e4-8f36bbf41046",
  DownloadLink: null,
} as const;

/** The captured decision file the download serves for that row. */
const HU_BHGY_DOCUMENT = new URL(
  "../../handlers/case-law/ingestion/parsers/__fixtures__/hu-bhgy-decision.docx",
  import.meta.url,
);

/**
 * Built from the row and the captured file, through the adapter's own envelope
 * writer: the guards read the header labels back out of the stored document,
 * so a fixture that skipped the file would certify half the inventory.
 */
export const huBhgyFixture = (): EnrolledAdapterFixture => ({
  buildDecision: async () => {
    const bytes = new Uint8Array(
      await Bun.file(HU_BHGY_DOCUMENT).arrayBuffer(),
    );
    const document =
      huBhgyDocumentOf(bytes) ??
      panic("the hu-bhgy fixture is not a decision file");
    const row = { ...HU_BHGY_LISTING_ROW };
    const built = await assembleHuBhgyDecision({
      row: normalizeHuBhgyRow(row),
      document,
      rawParts: huBhgyRawPartsOf(row, document),
    });
    return built.type === "unkeyable"
      ? panic("hu-bhgy fixture did not build")
      : built.decision;
  },
});
