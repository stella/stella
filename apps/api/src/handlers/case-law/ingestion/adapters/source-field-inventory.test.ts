/**
 * Source-field conformance: what every case-law adapter must say about the
 * fields its publisher states.
 *
 * A per-adapter test certifies what its author noticed, which is exactly the
 * blind spot: a labelled field on a page the adapter already fetches can go
 * unread for years and no assertion anywhere goes red, because nobody wrote
 * one about a field they did not see. So the check lives outside the adapters
 * and is driven from the registry: each enrolled adapter reads its own fixture
 * back through `listSourceFields`, and every name that comes out has to be in
 * the inventory as stored or as excluded with a reason.
 *
 * Three invariants, run over every registered adapter:
 *
 * 1. The pending baseline names exactly the adapters without an inventory, so
 *    the un-inventoried set can only shrink.
 * 2. For an enrolled adapter: every field its fixture states is in the map,
 *    and every field the map stores is on the decision built from that
 *    fixture — at the metadata key, result field, document or identity the
 *    disposition names.
 * 3. The page the inventory reads is one of the parts of the stored raw. A
 *    field captured later is only recoverable for stored rows if the response
 *    stating it was kept.
 */

import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { AdapterKey } from "@/api/handlers/case-law/consts";
import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceFieldDisposition,
  SourceFieldTarget,
} from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { buildCzNsDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { buildCzNssDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import baseline from "@/api/handlers/case-law/ingestion/adapters/source-field-inventory-baseline.json";
import { storeTextField } from "@/api/lib/case-law/decision-text";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

const czNsFixture = (): InventoryFixture => ({
  payload: CZ_NS_DETAIL_PAGE,
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

const czNssFixture = (): InventoryFixture => ({
  payload: CZ_NSS_DETAIL_PAGE,
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

// ── Coverage declaration ─────────────────────────────────

type InventoryFixture = {
  /** A publisher payload of the kind the adapter's extractor reads. */
  readonly payload: string;
  /** The decision this adapter builds from that payload. */
  readonly buildDecision: () => Promise<IngestionResult>;
};

/**
 * What this suite has to drive one adapter with. Enrolment is stated twice on
 * purpose — here and on the adapter itself — and the first assertion below
 * fails when the two disagree, so a fixture cannot quietly go missing for an
 * adapter that declares an inventory.
 */
type AdapterInventoryCoverage =
  | {
      readonly disposition: "enrolled";
      readonly fixture: () => InventoryFixture;
    }
  | { readonly disposition: "pending-inventory" };

const PENDING = { disposition: "pending-inventory" } as const;

const ADAPTER_INVENTORY_COVERAGE = {
  [ADAPTER_KEYS.CZ_NS]: { disposition: "enrolled", fixture: czNsFixture },
  [ADAPTER_KEYS.CZ_NSS]: { disposition: "enrolled", fixture: czNssFixture },
  [ADAPTER_KEYS.CZ_US]: PENDING,
  [ADAPTER_KEYS.CZ_REGIONAL]: PENDING,
  [ADAPTER_KEYS.SK_COURTS]: PENDING,
  [ADAPTER_KEYS.SK_US]: PENDING,
  [ADAPTER_KEYS.PL_COURTS]: PENDING,
  [ADAPTER_KEYS.AT_COURTS]: PENDING,
  [ADAPTER_KEYS.AT_VFGH]: PENDING,
  [ADAPTER_KEYS.AT_VWGH]: PENDING,
  [ADAPTER_KEYS.AT_BVWG]: PENDING,
  [ADAPTER_KEYS.AT_LVWG]: PENDING,
  [ADAPTER_KEYS.AT_ASYLGH]: PENDING,
  [ADAPTER_KEYS.AT_UBAS]: PENDING,
  [ADAPTER_KEYS.AT_UVS]: PENDING,
  [ADAPTER_KEYS.AT_VERG]: PENDING,
  [ADAPTER_KEYS.AT_UMSE]: PENDING,
  [ADAPTER_KEYS.AT_BKS]: PENDING,
  [ADAPTER_KEYS.AT_FINDOK]: PENDING,
  [ADAPTER_KEYS.EU_ECJ]: PENDING,
} as const satisfies Record<AdapterKey, AdapterInventoryCoverage>;

const DECLARED_ADAPTER_KEYS = Object.values(ADAPTER_KEYS);

const PENDING_BASELINE: readonly string[] = baseline.pendingInventory;

const adapterFor = (key: AdapterKey) =>
  getAdapter(key) ?? panic(`${key} is declared but not registered`);

// ── Reading a stored field back ──────────────────────────

const isPresent = (value: unknown): boolean => {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return Array.isArray(value) ? value.length > 0 : true;
};

/** What the row holds where a disposition says the field is stored. */
const storedValueOf = (
  decision: IngestionResult,
  target: SourceFieldTarget,
): unknown => {
  switch (target.type) {
    case "metadata":
      return decision.metadata[target.key];
    case "textField":
      return storeTextField(decision.textFields[target.key]);
    case "result":
      return decision[target.key];
    case "document":
      return "blocks" in decision.documentAst &&
        decision.documentAst.blocks.length > 0
        ? decision.documentAst
        : (decision.fulltext ?? undefined);
    case "identity":
      return decision.sourceDocumentId;
    default: {
      target satisfies never;
      return panic(`Unhandled source-field target: ${JSON.stringify(target)}`);
    }
  }
};

const describeTarget = (target: SourceFieldTarget): string => {
  switch (target.type) {
    case "metadata":
      return `metadata.${target.key}`;
    case "textField":
      return `textFields.${target.key}`;
    case "result":
      return `the result's ${target.key}`;
    case "document":
      return "the parsed document";
    case "identity":
      return "the row's identity";
    default: {
      target satisfies never;
      return panic(`Unhandled source-field target: ${JSON.stringify(target)}`);
    }
  }
};

// ── Invariants ───────────────────────────────────────────

describe("every adapter accounts for the fields its source states", () => {
  test("the pending baseline names exactly the adapters without an inventory", () => {
    const pending = DECLARED_ADAPTER_KEYS.filter(
      (key) => adapterFor(key).sourceFields.status === "pending-inventory",
    );
    const enrolledButListed = PENDING_BASELINE.filter(
      (key) => !pending.some((candidate) => candidate === key),
    );
    const pendingButUnlisted = pending.filter(
      (key) => !PENDING_BASELINE.includes(key),
    );

    // A ratchet only tightens: an adapter that enrolled leaves the baseline,
    // and a new adapter without an inventory has to be added to it in the
    // same change rather than inheriting the exemption silently.
    expect(
      enrolledButListed,
      `source-field-inventory-baseline.json still lists adapters that now declare an inventory: ${enrolledButListed.join(", ")}. Delete those lines.`,
    ).toEqual([]);
    expect(
      pendingButUnlisted,
      `these adapters declare PENDING_SOURCE_FIELD_INVENTORY without being in source-field-inventory-baseline.json: ${pendingButUnlisted.join(", ")}. Declare their source fields, or add them to the baseline in this change.`,
    ).toEqual([]);
  });

  for (const key of DECLARED_ADAPTER_KEYS) {
    const coverage = ADAPTER_INVENTORY_COVERAGE[key];

    test(`${key}: its fixture matches how it declares itself`, () => {
      const { status } = adapterFor(key).sourceFields;
      expect(
        coverage.disposition === "enrolled",
        `${key} declares ${status} but this suite has it as ${coverage.disposition}. An adapter with an inventory needs a fixture here to drive it.`,
      ).toBe(status === "declared");
    });

    if (coverage.disposition === "pending-inventory") {
      continue;
    }

    test(`${key}: every field its source states is stored or excluded`, async () => {
      const { sourceFields } = adapterFor(key);
      if (sourceFields.status !== "declared") {
        throw new Error(`${key}: expected a declared inventory`);
      }
      const { payload, buildDecision } = coverage.fixture();

      const stated = sourceFields.listSourceFields(payload);
      expect(
        stated.length,
        `${key}: the fixture states no fields at all, so this suite would certify nothing. Check listSourceFields against the fixture's markup.`,
      ).toBeGreaterThan(0);

      const undeclared = stated.filter(
        (field) => sourceFields.fields[field] === undefined,
      );
      expect(
        undeclared,
        `${key}: its source states fields nothing decided about: ${undeclared.join(", ")}. Store them, or exclude them with the reason.`,
      ).toEqual([]);

      // `excludedSourceField` rejects a blank reason at the call site, so this
      // is the backstop for a reason that reaches an inventory some other way.
      const unreasoned = stated.filter((field) => {
        const disposition: SourceFieldDisposition | undefined =
          sourceFields.fields[field];
        return (
          disposition?.disposition === "excluded" &&
          disposition.reason.trim().length === 0
        );
      });
      expect(
        unreasoned,
        `${key}: these fields are excluded with a blank reason: ${unreasoned.join(", ")}. An exclusion nobody explained is the silence this suite exists to break.`,
      ).toEqual([]);

      // The other direction, or a disposition could be declared and never
      // exercised: the checks below only walk what the fixture states, so a
      // stored field missing from the fixture would be certified by nothing.
      const unexercised = Object.keys(sourceFields.fields).filter(
        (field) => !stated.includes(field),
      );
      expect(
        unexercised,
        `${key}: its inventory declares fields the fixture does not state: ${unexercised.join(", ")}. The fixture is the union of what the source's pages state, so add them there or drop them from the inventory.`,
      ).toEqual([]);

      const decision = await buildDecision();
      const unstored = stated.flatMap((field) => {
        const disposition: SourceFieldDisposition | undefined =
          sourceFields.fields[field];
        if (disposition?.disposition !== "stored") {
          return [];
        }
        return isPresent(storedValueOf(decision, disposition.target))
          ? []
          : [`${field} -> ${describeTarget(disposition.target)}`];
      });

      expect(
        unstored,
        `${key}: these fields are declared stored, and the decision built from the fixture that states them does not carry them: ${unstored.join("; ")}.`,
      ).toEqual([]);

      // What the inventory reads has to survive in the raw, or a field read
      // later is unrecoverable for every row already stored: replay can only
      // re-read what was kept.
      const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
      expect(
        Object.values(parts ?? {}),
        `${key}: the page its inventory reads is not among the parts of the stored raw, so a field captured later could never be recovered from a stored row. Store every response fetched for the decision.`,
      ).toContain(payload);
    });
  }
});
