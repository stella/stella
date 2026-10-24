import { panic } from "better-result";
import { Glob } from "bun";
import * as cheerio from "cheerio";
import path from "node:path";

import { createCaseLawDecisionSlug } from "@stll/api-contract/case-law-decision-route";
import { isDocumentAst } from "@stll/legal-ast/document-ast";
import { PROVISION_CITATION_GRAMMARS } from "@stll/legal-atlas/provision-citation-grammars";

import { assembleAtRisDecision } from "../apps/api/src/handlers/case-law/ingestion/adapters/at-courts";
import {
  assembleAtFindokDecision,
  parseFindokManifest,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/at-findok";
import { czNsAdapter } from "../apps/api/src/handlers/case-law/ingestion/adapters/cz-ns";
import {
  assembleCzRegionalDecision,
  isCzRegionalApiItem,
  readCzRegionalChain,
  readCzRegionalDocument,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/cz-regional";
import { czUsAdapter } from "../apps/api/src/handlers/case-law/ingestion/adapters/cz-us";
import {
  assembleHuBhgyDecision,
  huBhgyDocumentOf,
  huBhgyRawPartsOf,
  normalizeHuBhgyRow,
  readHuBhgySearch,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/hu-bhgy";
import { plCourtsAdapter } from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-courts";
import { plSnAdapter } from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-sn";
import { skCourtsAdapter } from "../apps/api/src/handlers/case-law/ingestion/adapters/sk-courts";
import { skUsAdapter } from "../apps/api/src/handlers/case-law/ingestion/adapters/sk-us";
import {
  decisionIdentifiersFromMetadata,
  extractDecisionCitations,
  isSelfCitation,
} from "../apps/api/src/handlers/case-law/ingestion/citation-extractor";
import { metadataUrlSchemaForAdapter } from "../apps/api/src/handlers/case-law/ingestion/metadata-url-schemas";
import { parseNssDecisionHtml } from "../apps/api/src/handlers/case-law/ingestion/parsers/cz-nss";
import { parseRegionalDecision } from "../apps/api/src/handlers/case-law/ingestion/parsers/cz-regional";
import { parseUsDecisionHtml } from "../apps/api/src/handlers/case-law/ingestion/parsers/cz-us";
import {
  ecjDocumentRoot,
  parseEcjDecisionHtml,
} from "../apps/api/src/handlers/case-law/ingestion/parsers/eu-ecj";
import { parseSkUsDocumentXhtml } from "../apps/api/src/handlers/case-law/ingestion/parsers/sk-us";
import { segmentDecision } from "../apps/api/src/handlers/case-law/ingestion/segmenter";
import { judgeNameKey } from "../apps/api/src/handlers/case-law/judges/judge-name";
import { loadDocxArchive } from "../apps/api/src/lib/docx-archive";
import { sanitizeResult } from "../apps/api/src/lib/legal-search/ingestion-normalization";
import {
  type DecisionSupplement,
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  type IngestionResult,
  type RawIngestionResult,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  toPlainTextIngestionResult,
} from "../apps/api/src/lib/legal-search/ingestion-types";
import {
  type LogRecord,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "../apps/api/src/lib/observability/logger";
import { isRecord } from "../apps/api/src/lib/type-guards";
import { collectPolishFixtures } from "./parser-output-polish-fixtures";

const INGESTION = "apps/api/src/handlers/case-law/ingestion";

const text = async (filePath: string) => {
  const bytes = await Bun.file(filePath).bytes();
  return new TextDecoder().decode(
    filePath.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes,
  );
};

const stableDiagnostic = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableDiagnostic);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...stableDiagnosticFields(value),
    };
  }
  return isRecord(value) ? stableDiagnosticFields(value) : value;
};

const stableDiagnosticFields = (value: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/(?:^|\.)(?:stack|durationMs|elapsedMs|timestamp)$/u.test(key),
      )
      .map(([key, field]) => [key, stableDiagnostic(field)]),
  );

const storedInput = (seed: IngestionResult, raw: string) => ({
  raw: new TextEncoder().encode(raw),
  contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  caseNumber: seed.caseNumber,
  sourceDocumentId: seed.sourceDocumentId ?? null,
  language: seed.language,
  court: seed.court,
  ecli: seed.ecli ?? null,
  decisionDate: seed.decisionDate ?? null,
  decisionType: seed.decisionType ?? null,
  sourceUrl: seed.sourceUrl ?? null,
  documentUrl: seed.documentUrl ?? null,
  metadata: seed.metadata,
});

/** Values derived without consulting the mutable database or allocating row IDs. */
const persistedOutput = (adapter: string, raw: RawIngestionResult) => {
  const schema = metadataUrlSchemaForAdapter(adapter);
  const result = sanitizeResult(
    toPlainTextIngestionResult(raw, schema).unwrap(
      "A recorded fixture is a valid ingestion result",
    ),
    schema,
  );
  const sections =
    result.sections ??
    (result.fulltext ? segmentDecision(result.fulltext) : []);
  const extraction = extractDecisionCitations({
    country: result.country,
    sections,
    documentAst: isDocumentAst(result.documentAst)
      ? result.documentAst
      : undefined,
    citationScopes: result.citationScopes,
  }).unwrap("Citation extraction over recorded fixture text succeeds");
  const grammar =
    Object.values(PROVISION_CITATION_GRAMMARS).find(
      ({ jurisdiction }) => jurisdiction === result.country,
    ) ?? panic(`No provision citation grammar for ${result.country}`);
  const provisionMentions =
    grammar.status === "supported"
      ? sections.flatMap(({ index, text: body }) =>
          grammar
            .locateAbbreviatedProvisions(body)
            .map((mention) => ({ sectionIndex: index, ...mention })),
        )
      : [];
  // A version bump is bookkeeping, not evidence that parsed fields differ.
  const { parserVersion: _parserVersion, ...fields } = result;
  const identifiers = decisionIdentifiersFromMetadata({
    caseNumber: result.caseNumber,
    caseNumberType: result.caseNumberType,
    ecli: result.ecli ?? null,
    identifiers: result.identifiers,
    jurisdiction: result.country,
  });
  return {
    ...fields,
    documentAst: extraction.documentAst ?? result.documentAst,
    slug: createCaseLawDecisionSlug(result.caseNumber),
    judgeNameKeys:
      result.judges === undefined
        ? undefined
        : [
            ...new Set(
              result.judges
                .map(({ nameAsPrinted }) => judgeNameKey(nameAsPrinted))
                .filter((key) => key !== ""),
            ),
          ],
    sections,
    extractedCitations: {
      ...extraction,
      citations: extraction.citations.filter(
        ({ citationText }) => !isSelfCitation(citationText, identifiers),
      ),
    },
    provisionMentions,
  };
};

type FixtureOutputOptions = {
  adapter: string;
  fixture: string;
  output: unknown;
};
type FixtureDecisionOptions = {
  adapter: string;
  fixture: string;
  decision: IngestionResult;
};
type FixtureSupplementOptions = {
  adapter: string;
  fixture: string;
  supplement: DecisionSupplement;
};

const createCollector = async (fixtureRoot: string, warnings: LogRecord[]) => {
  const outputs = new Map<string, Map<string, unknown>>();
  const adapterFixtures = path.join(
    fixtureRoot,
    INGESTION,
    "adapters/__fixtures__",
  );
  const { AT_RIS_SOURCES, CASE_LAW_CONFORMANCE_FIXTURES } =
    await import("../apps/api/src/tests/helpers/case-law-enrolled-fixtures");
  const { mapCourtListenerRecord } =
    await import("../apps/api/src/handlers/case-law/ingestion/adapters/courtlistener/map");
  const { courtListenerRecord, opinionRow, recordedClusters } =
    await import("../apps/api/src/handlers/case-law/ingestion/adapters/courtlistener/test-records");
  const addOutput = ({ adapter, fixture, output }: FixtureOutputOptions) => {
    let rows = outputs.get(adapter);
    if (rows === undefined) {
      rows = new Map<string, unknown>();
      outputs.set(adapter, rows);
    }
    if (rows.has(fixture)) {
      panic(`Duplicate parser output fixture: ${adapter}/${fixture}`);
    }
    rows.set(fixture, output);
  };
  if (warnings.length > 0) {
    addOutput({
      adapter: "us-courtlistener",
      fixture: "module-initialization warnings",
      output: warnings.splice(0).map(stableDiagnostic),
    });
  }
  const add = ({ adapter, fixture, decision }: FixtureDecisionOptions) => {
    addOutput({
      adapter,
      fixture,
      output: {
        ...persistedOutput(adapter, decision),
        warnings: warnings.splice(0).map(stableDiagnostic),
      },
    });
  };
  const seeds = new Map<string, IngestionResult>();
  const addSupplement = ({
    adapter,
    fixture,
    supplement,
  }: FixtureSupplementOptions) => {
    addOutput({
      adapter,
      fixture,
      output: {
        kind: supplement.kind,
        target: supplement.target,
        document: persistedOutput(adapter, supplement.document),
        warnings: warnings.splice(0).map(stableDiagnostic),
      },
    });
  };
  const parserFixtures = path.join(
    fixtureRoot,
    INGESTION,
    "parsers/__fixtures__",
  );
  return {
    fixtureRoot,
    warnings,
    outputs,
    adapterFixtures,
    parserFixtures,
    AT_RIS_SOURCES,
    CASE_LAW_CONFORMANCE_FIXTURES,
    mapCourtListenerRecord,
    courtListenerRecord,
    opinionRow,
    recordedClusters,
    add,
    addSupplement,
    addOutput,
    seeds,
  };
};

type CollectorContext = Awaited<ReturnType<typeof createCollector>>;

const collectSeeds = async ({
  CASE_LAW_CONFORMANCE_FIXTURES,
  add,
  seeds,
}: CollectorContext) => {
  for (const [key, fixture] of Object.entries(CASE_LAW_CONFORMANCE_FIXTURES)) {
    const evidence = fixture();
    const originalFetch = globalThis.fetch;
    try {
      const decision = await evidence.buildDecision();
      seeds.set(key, decision);
      add({
        adapter: key,
        fixture:
          "conformance (synthetic field census; recorded documents where supplied)",
        decision,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
};

const collectCzechDocuments = async ({
  adapterFixtures,
  parserFixtures,
  add,
  seeds,
}: CollectorContext) => {
  const usSeed = seeds.get("cz-us") ?? panic("Missing CZ US fixture seed");
  const usParts =
    decodeSourceRawEnvelope(usSeed.sourceRaw ?? "") ??
    panic("Missing CZ US census envelope");
  for (const filename of [
    ...new Glob("cz-us-record-card*.html.gz").scanSync(adapterFixtures),
  ].toSorted()) {
    const raw = encodeSourceRawEnvelope({
      ...usParts,
      detail: await text(path.join(adapterFixtures, filename)),
    });
    const replayed = await czUsAdapter.reparseStoredRaw?.(
      storedInput(usSeed, raw),
    );
    if (replayed?.type !== "parsed") {
      panic(
        replayed === undefined
          ? `${filename} returned no result`
          : `${filename} returned ${replayed.type}`,
      );
    }
    add({
      adapter: "cz-us",
      fixture: `${filename} (recorded record card; census document)`,
      decision: replayed.result,
    });
  }
  for (const adapter of ["cz-nss", "cz-us"]) {
    const seed = seeds.get(adapter) ?? panic(`Missing ${adapter} fixture seed`);
    for (const filename of [
      ...new Glob(`${adapter}-*.html.gz`).scanSync(parserFixtures),
    ].toSorted()) {
      const input = {
        ...seed,
        ecli: seed.ecli,
        decisionDate: seed.decisionDate,
        decisionType: seed.decisionType,
        sourceUrl: seed.sourceUrl,
        html: await text(path.join(parserFixtures, filename)),
        detailMetadata: {},
      };
      const parsed =
        adapter === "cz-nss"
          ? parseNssDecisionHtml(input)
          : parseUsDecisionHtml(input);
      add({
        adapter,
        fixture: `${filename} (recorded document; census metadata)`,
        decision: {
          ...seed,
          ...parsed,
        },
      });
    }
  }
};

const collectSlovakDocuments = async ({
  fixtureRoot,
  adapterFixtures,
  parserFixtures,
  add,
  seeds,
}: CollectorContext) => {
  const skSeed = seeds.get("sk-us") ?? panic("Missing sk-us fixture seed");
  const skListing: unknown = JSON.parse(
    await text(path.join(adapterFixtures, "sk-us-listing.json.gz")),
  );
  const skRow =
    isRecord(skListing) && Array.isArray(skListing["documents"])
      ? skListing["documents"].at(0)
      : undefined;
  if (!isRecord(skRow) || typeof skRow["mkRSAPNumberOfFile"] !== "string") {
    panic("Missing recorded SK US listing identity");
  }
  const skContent: unknown = JSON.parse(
    await text(path.join(adapterFixtures, "sk-us-content.json.gz")),
  );
  if (!isRecord(skContent) || typeof skContent["content"] !== "string") {
    panic("Missing recorded SK US content");
  }
  const skRaw = encodeSourceRawEnvelope({
    listing: JSON.stringify(skRow),
    document: Buffer.from(skContent["content"], "base64").toString("utf-8"),
    facets: await text(path.join(adapterFixtures, "sk-us-facets.json.gz")),
    codelists: await text(path.join(adapterFixtures, "sk-us-codelist.json.gz")),
    file: await text(path.join(adapterFixtures, "sk-us-file.json.gz")),
    "collection-listing": await text(
      path.join(adapterFixtures, "sk-us-collection.json.gz"),
    ),
  });
  const skReplayed = await skUsAdapter.reparseStoredRaw?.({
    ...storedInput(skSeed, skRaw),
    caseNumber: skRow["mkRSAPNumberOfFile"],
  });
  if (skReplayed?.type !== "parsed") {
    panic(
      skReplayed === undefined
        ? "SK US captured envelope returned no result"
        : `SK US captured envelope returned ${skReplayed.type}`,
    );
  }
  add({
    adapter: "sk-us",
    fixture:
      "sk-us-listing+content+facets+codelist+file+collection (recorded capture)",
    decision: skReplayed.result,
  });
  for (const filePath of [
    path.join(adapterFixtures, "sk-us-content.json.gz"),
    ...[...new Glob("sk-us-*.content.json.gz").scanSync(parserFixtures)].map(
      (name) => path.join(parserFixtures, name),
    ),
  ]) {
    const payload: unknown = JSON.parse(await text(filePath));
    if (!isRecord(payload) || typeof payload["content"] !== "string") {
      panic(`${filePath}: no base64 XHTML content`);
    }
    const parsed = parseSkUsDocumentXhtml({
      ...skSeed,
      ecli: skSeed.ecli,
      decisionDate: skSeed.decisionDate,
      decisionType: skSeed.decisionType,
      documentUrl: skSeed.documentUrl ?? panic("sk-us has no document URL"),
      xhtml: Buffer.from(payload["content"], "base64").toString("utf-8"),
    });
    add({
      adapter: "sk-us",
      fixture: `${filePath.slice(fixtureRoot.length + 1)} (recorded document; census metadata)`,
      decision: { ...skSeed, ...parsed },
    });
  }
};

const collectEuropeanDocuments = async ({
  warnings,
  adapterFixtures,
  parserFixtures,
  add,
  addOutput,
  seeds,
}: CollectorContext) => {
  const ecjSeed = seeds.get("eu-ecj") ?? panic("Missing eu-ecj fixture seed");
  for (const filename of [
    ...new Glob("*.html.gz").scanSync(path.join(parserFixtures, "eu-ecj")),
  ].toSorted()) {
    if (filename.includes("shell")) {
      const html = await text(path.join(parserFixtures, "eu-ecj", filename));
      addOutput({
        adapter: "eu-ecj",
        fixture: `eu-ecj/${filename}`,
        output: {
          boundary: ecjDocumentRoot(cheerio.load(html)).boundary,
          warnings: warnings.splice(0).map(stableDiagnostic),
        },
      });
      continue;
    }
    const [celex, language] = filename.split(".");
    if (!celex || !language) {
      panic(`Invalid ECJ fixture name: ${filename}`);
    }
    const parsed = parseEcjDecisionHtml({
      ...ecjSeed,
      ecli: ecjSeed.ecli,
      decisionDate: ecjSeed.decisionDate,
      decisionType: ecjSeed.decisionType,
      sourceUrl: ecjSeed.sourceUrl,
      celex,
      language,
      html: await text(path.join(parserFixtures, "eu-ecj", filename)),
    });
    add({
      adapter: "eu-ecj",
      fixture: `eu-ecj/${filename} (recorded document; census metadata)`,
      decision: {
        ...ecjSeed,
        ...parsed,
        language,
      },
    });
  }
  for (const filename of [
    ...new Glob("eu-ecj-*.page.html.gz").scanSync(adapterFixtures),
  ].toSorted()) {
    const [celex, language] = filename.slice("eu-ecj-".length).split(".");
    if (!celex || !language) {
      panic(`Invalid ECJ portal fixture name: ${filename}`);
    }
    const parsed = parseEcjDecisionHtml({
      ...ecjSeed,
      ecli: ecjSeed.ecli,
      decisionDate: ecjSeed.decisionDate,
      decisionType: ecjSeed.decisionType,
      sourceUrl: ecjSeed.sourceUrl,
      celex,
      language,
      html: await text(path.join(adapterFixtures, filename)),
    });
    add({
      adapter: "eu-ecj",
      fixture: `${filename} (recorded portal document; census metadata)`,
      decision: {
        ...ecjSeed,
        ...parsed,
        language,
      },
    });
  }
};

const courtListenerFormat = (filename: string) => {
  if (filename.startsWith("html-with-citations-")) {
    return "html_with_citations";
  }
  if (filename.startsWith("html-lawbox-")) {
    return "html_lawbox";
  }
  if (filename.startsWith("html-columbia-")) {
    return "html_columbia";
  }
  if (filename.startsWith("html-anon-2020-")) {
    return "html_anon_2020";
  }
  return "html";
};

const collectAmericanDocuments = async ({
  fixtureRoot,
  warnings,
  mapCourtListenerRecord,
  courtListenerRecord,
  opinionRow,
  recordedClusters,
  add,
  addOutput,
}: CollectorContext) => {
  for (const [index, record] of recordedClusters().entries()) {
    add({
      adapter: "us-courtlistener",
      fixture: `courtlistener-clusters-2026-06-30.ndjson.gz[${index}]`,
      decision: mapCourtListenerRecord(record).unwrap(
        "A recorded CourtListener cluster maps to a decision",
      ),
    });
  }
  const courtListenerFixtures = path.join(
    fixtureRoot,
    INGESTION,
    "parsers/courtlistener/__fixtures__/html",
  );
  for (const filename of [
    ...new Glob("*.html").scanSync(courtListenerFixtures),
  ].toSorted()) {
    const format = courtListenerFormat(filename);
    const record = courtListenerRecord({
      opinions: [
        opinionRow({
          xml_harvard: "",
          [format]: await text(path.join(courtListenerFixtures, filename)),
          plain_text: "",
        }),
      ],
    });
    const mapped = mapCourtListenerRecord(record);
    const fixture = `courtlistener/html/${filename} (recorded document; census metadata)`;
    if (mapped.isErr()) {
      addOutput({
        adapter: "us-courtlistener",
        fixture,
        output: {
          type: "rejected",
          error: stableDiagnostic(mapped.error),
          warnings: warnings.splice(0).map(stableDiagnostic),
        },
      });
    } else {
      add({ adapter: "us-courtlistener", fixture, decision: mapped.value });
    }
  }
};

const collectHungarianDocuments = async ({
  adapterFixtures,
  parserFixtures,
  add,
}: CollectorContext) => {
  const huListing: unknown = JSON.parse(
    await text(
      path.join(adapterFixtures, "hu-bhgy-listing-2000-gazdasagi.json"),
    ),
  );
  const huRows =
    readHuBhgySearch(huListing) ?? panic("Invalid hu-bhgy recorded listing");
  const huDocument =
    huBhgyDocumentOf(
      await Bun.file(
        path.join(parserFixtures, "hu-bhgy-decision.docx"),
      ).bytes(),
    ) ?? panic("Invalid hu-bhgy document");
  for (const [index, row] of huRows.rows.entries()) {
    const built = await assembleHuBhgyDecision({
      row: normalizeHuBhgyRow(row),
      document: huDocument,
      rawParts: huBhgyRawPartsOf(row, huDocument),
    });
    if (built.type !== "built") {
      panic(`hu-bhgy recorded listing row ${index}: ${built.type}`);
    }
    add({
      adapter: "hu-bhgy",
      fixture: `hu-bhgy-listing-2000-gazdasagi.json[${index}]+hu-bhgy-decision.docx`,
      decision: built.decision,
    });
  }
};

const collectRegionalDocuments = async ({
  adapterFixtures,
  parserFixtures,
  add,
  seeds,
}: CollectorContext) => {
  const regionalListing: unknown = JSON.parse(
    await text(path.join(adapterFixtures, "cz-regional-listing.json.gz")),
  );
  if (!isRecord(regionalListing) || !Array.isArray(regionalListing["items"])) {
    panic("Invalid recorded regional listing");
  }
  for (const [filename, docket] of [
    ["cz-regional-finaldoc-district.json.gz", "18 C 130/2024-27"],
    ["cz-regional-finaldoc-appellate.json.gz", "26 Co 43/2025-49"],
  ]) {
    if (!filename || !docket) {
      panic("Invalid regional fixture declaration");
    }
    const item = regionalListing["items"].find(
      (value: unknown) =>
        isCzRegionalApiItem(value) && value.jednaciCislo === docket,
    );
    if (!isCzRegionalApiItem(item)) {
      panic(`Missing regional listing ${docket}`);
    }
    const built = assembleCzRegionalDecision({
      item,
      document: readCzRegionalDocument(
        await text(path.join(adapterFixtures, filename)),
      ),
      chain: readCzRegionalChain(
        await text(path.join(adapterFixtures, "cz-regional-chain.json.gz")),
      ),
    });
    if (built.type !== "built") {
      panic(`${filename}: ${built.type}`);
    }
    add({
      adapter: "cz-regional",
      fixture: filename,
      decision: built.decision,
    });
  }
  const regionalSeed =
    seeds.get("cz-regional") ?? panic("Missing cz-regional fixture seed");
  for (const filename of [
    ...new Glob("cz-regional-*.finaldoc.json.gz").scanSync(parserFixtures),
  ].toSorted()) {
    const document =
      readCzRegionalDocument(await text(path.join(parserFixtures, filename)))
        .parsed ?? panic(`${filename} is not finaldoc`);
    const parsed = parseRegionalDecision({
      ...regionalSeed,
      ecli: regionalSeed.ecli,
      decisionDate: regionalSeed.decisionDate,
      decisionType: regionalSeed.decisionType,
      sourceUrl: regionalSeed.sourceUrl,
      header: document.header ?? [],
      verdict: document.verdict ?? [],
      justification: document.justification ?? [],
      information: document.information ?? [],
      styles: document.styles ?? [],
      verdictText: document.verdictText ?? "",
      justificationText: document.justificationText ?? "",
    });
    add({
      adapter: "cz-regional",
      fixture: `${filename} (recorded document; census metadata)`,
      decision: {
        ...regionalSeed,
        ...parsed,
      },
    });
  }
};

const collectRecordedPages = async ({
  warnings,
  adapterFixtures,
  AT_RIS_SOURCES,
  add,
  addSupplement,
  addOutput,
}: CollectorContext) => {
  for (const filename of [
    ...new Glob("*-page.json.gz").scanSync(adapterFixtures),
  ].toSorted()) {
    const data: unknown = JSON.parse(
      await text(path.join(adapterFixtures, filename)),
    );
    if (
      !isRecord(data) ||
      typeof data["adapter"] !== "string" ||
      !isRecord(data["page"]) ||
      !Array.isArray(data["page"]["decisions"])
    ) {
      panic(`Invalid recorded page: ${filename}`);
    }
    const adapter = data["adapter"];
    for (const [index, raw] of data["page"]["decisions"].entries()) {
      if (!isRecord(raw) || typeof raw["sourceRaw"] !== "string") {
        panic(`${filename}[${index}] has no raw source`);
      }
      if (adapter === "at-courts") {
        const stored: unknown = JSON.parse(raw["sourceRaw"]);
        if (!isRecord(stored) || !isRecord(stored["listing"])) {
          panic(`${filename}[${index}] has no RIS listing`);
        }
        const source = AT_RIS_SOURCES["at-courts"];
        add({
          adapter,
          fixture: `${filename}[${index}]`,
          decision: assembleAtRisDecision(source, stored["listing"], {
            documentXml:
              typeof stored["documentXml"] === "string"
                ? stored["documentXml"]
                : "",
          }),
        });
        continue;
      }
      const source =
        [
          czNsAdapter,
          czUsAdapter,
          skCourtsAdapter,
          plCourtsAdapter,
          plSnAdapter,
        ].find(({ key }) => key === adapter) ??
        panic(`Unregistered recorded-page adapter: ${adapter}`);
      const replay =
        source.reparseStoredRaw ?? panic(`No stored-raw parser: ${adapter}`);
      const required = (key: string) =>
        typeof raw[key] === "string"
          ? raw[key]
          : panic(`${filename}[${index}].${key} is not a string`);
      const nullable = (key: string) =>
        typeof raw[key] === "string" ? raw[key] : null;
      const parsed = await replay({
        raw: new TextEncoder().encode(raw["sourceRaw"]),
        contentType: nullable("sourceRawContentType"),
        caseNumber: required("caseNumber"),
        sourceDocumentId: nullable("sourceDocumentId"),
        language: required("language"),
        court: required("court"),
        ecli: nullable("ecli"),
        decisionDate: nullable("decisionDate"),
        decisionType: nullable("decisionType"),
        sourceUrl: nullable("sourceUrl"),
        documentUrl: nullable("documentUrl"),
        metadata: isRecord(raw["metadata"])
          ? raw["metadata"]
          : panic(`${filename}[${index}] has no metadata`),
      });
      const fixture = `${filename}[${index}]`;
      switch (parsed.type) {
        case "parsed":
          add({ adapter, fixture, decision: parsed.result });
          break;
        case "supplement":
          addSupplement({ adapter, fixture, supplement: parsed.supplement });
          break;
        case "rejected": {
          addOutput({
            adapter,
            fixture,
            output: {
              ...parsed,
              warnings: warnings.splice(0).map(stableDiagnostic),
            },
          });
          break;
        }
        default: {
          parsed satisfies never;
          panic(`Unhandled stored raw outcome for ${adapter}`);
        }
      }
    }
  }
};

const collectAustrianRisDocuments = async ({
  fixtureRoot,
  adapterFixtures,
  parserFixtures,
  AT_RIS_SOURCES,
  add,
}: CollectorContext) => {
  for (const [adapter, source] of Object.entries(AT_RIS_SOURCES)) {
    const filename = `at-ris-listing-${source.application.toLowerCase()}.json`;
    const payload: unknown = JSON.parse(
      await text(path.join(adapterFixtures, filename)),
    );
    const answer = isRecord(payload) ? payload["OgdSearchResult"] : undefined;
    const results = isRecord(answer) ? answer["OgdDocumentResults"] : undefined;
    const items = isRecord(results)
      ? results["OgdDocumentReference"]
      : undefined;
    const rows = Array.isArray(items) ? items : [items];
    for (const [index, item] of rows.entries()) {
      if (!isRecord(item)) {
        panic(`${filename}[${index}] is not a listing item`);
      }
      // The source inventory test deliberately pairs every listing vocabulary
      // with this recorded document to exercise the shared RIS assembler.
      add({
        adapter,
        fixture: `${filename}[${index}]+at-ris-justiz-text.xml`,
        decision: assembleAtRisDecision(source, item, {
          documentXml: await text(
            path.join(
              fixtureRoot,
              INGESTION,
              "parsers/__fixtures__/at-ris-justiz-text.xml",
            ),
          ),
        }),
      });
    }
    const first = rows.at(0);
    if (!isRecord(first)) {
      panic(`${filename} has no first row`);
    }
    add({
      adapter,
      fixture: `${filename}[0]+at-ris-jjt-1925.xml (shared parser fixture)`,
      decision: assembleAtRisDecision(source, first, {
        documentXml: await text(
          path.join(parserFixtures, "at-ris-jjt-1925.xml"),
        ),
      }),
    });
    for (const document of [
      ...new Glob(`at-ris-${source.application.toLowerCase()}-*.xml`).scanSync(
        parserFixtures,
      ),
    ].toSorted()) {
      if (document === "at-ris-justiz-text.xml") {
        continue;
      }
      add({
        adapter,
        fixture: `${filename}[0]+${document}`,
        decision: assembleAtRisDecision(source, first, {
          documentXml: await text(path.join(parserFixtures, document)),
        }),
      });
    }
  }
};

const collectFindokDocuments = async ({
  parserFixtures,
  add,
  seeds,
}: CollectorContext) => {
  const findok =
    seeds.get("at-findok") ?? panic("Missing at-findok fixture seed");
  const findokParts =
    decodeSourceRawEnvelope(findok.sourceRaw ?? "") ??
    panic("Missing Findok seed envelope");
  const listing =
    findokParts["listing"] ?? panic("Missing Findok manifest item");
  const findokManifest = parseFindokManifest(
    "bfg",
    JSON.stringify({
      generierungsdatum: "18.09.2026 06:17",
      data: [JSON.parse(listing)],
    }),
  );
  const findokItem =
    findokManifest.items.at(0) ?? panic("Missing Findok seed manifest item");
  const archive = await loadDocxArchive(
    await Bun.file(path.join(parserFixtures, "at-findok-152649.zip")).bytes(),
    { maxEntries: 20, maxEntryBytes: 4_000_000, maxTotalBytes: 4_000_000 },
  );
  const documentXml =
    (await archive.readEntryString("Gesamt/152649.Entscheidungstext.xml")) ??
    panic("Findok archive missing document XML");
  const headnoteXml =
    (await archive.readEntryString("Gesamt/152649.Rechtssaetze.xml")) ??
    panic("Findok archive missing headnote XML");
  add({
    adapter: "at-findok",
    fixture: "at-findok-152649.zip (recorded archive; census manifest)",
    decision: assembleAtFindokDecision(
      { collection: "bfg", item: findokItem },
      { documentXml, headnoteXml },
    ),
  });
  const bfgManifest = parseFindokManifest(
    "bfg",
    JSON.stringify({
      generierungsdatum: "07.08.2026 06:16",
      data: [
        {
          stammNr: 152_257,
          pathZip: "152/152257/152257.zip",
          pathPdf: "152/152257/152257.1.pdf",
          dokumenttyp: "Bescheidbeschwerde - Einzel - Erkenntnis",
          behoerde: "BFG",
          appdat: "14.07.2026",
          gz: "RV/7500368/2026",
          titel: "Parkometerfall, 15 Minuten-Parkscheine verwendet",
          gueltigAb: "",
          inFindokSeitDate: "2026-08-06T14:54:41.882132",
          inFindokSeit: "06.08.2026 02:54:41",
          gueltig: true,
          dokumentId: "b68202a0-55e4-4dea-9e93-971f0b71ae32",
        },
      ],
    }),
  );
  const bfgItem =
    bfgManifest.items.at(0) ?? panic("Missing BFG test manifest item");
  add({
    adapter: "at-findok",
    fixture:
      "at-findok-bfg-2026.xml (recorded document; adapter test manifest)",
    decision: assembleAtFindokDecision(
      { collection: "bfg", item: bfgItem },
      {
        documentXml: await text(
          path.join(parserFixtures, "at-findok-bfg-2026.xml"),
        ),
      },
    ),
  });
};

const collectPolishDocuments = async ({
  fixtureRoot,
  add,
  addSupplement,
}: CollectorContext) => {
  await collectPolishFixtures(fixtureRoot, ({ adapter, fixture, decision }) => {
    if ("kind" in decision) {
      addSupplement({ adapter, fixture, supplement: decision });
    } else {
      add({ adapter, fixture, decision });
    }
  });
};

const collectOutputs = async (fixtureRoot: string, warnings: LogRecord[]) => {
  const context = await createCollector(fixtureRoot, warnings);
  await collectSeeds(context);
  await collectCzechDocuments(context);
  await collectSlovakDocuments(context);
  await collectEuropeanDocuments(context);
  await collectAmericanDocuments(context);
  await collectHungarianDocuments(context);
  await collectRegionalDocuments(context);
  await collectRecordedPages(context);
  await collectAustrianRisDocuments(context);
  await collectFindokDocuments(context);
  await collectPolishDocuments(context);
  return Object.fromEntries(
    [...context.outputs].map(([adapter, rows]) => [
      adapter,
      Object.fromEntries(rows),
    ]),
  );
};

export const collectParserOutputs = async (
  fixtureRoot: string,
): Promise<Record<string, Record<string, unknown>>> => {
  const warnings: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    if (record.severityText === "WARN" || record.severityText === "ERROR") {
      warnings.push(record);
    }
  });
  try {
    return await collectOutputs(fixtureRoot, warnings);
  } finally {
    resetLogSinkForTesting();
  }
};
