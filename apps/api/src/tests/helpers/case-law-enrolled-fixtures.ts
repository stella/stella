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

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { buildCzNsDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { buildCzNssDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import { buildCzUsDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import type { ListedDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import {
  assemblePlSnDecision,
  normalizePlSnDetail,
  readPlSnEnvelope,
} from "@/api/handlers/case-law/ingestion/adapters/pl-sn";
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
