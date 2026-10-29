/**
 * Reads a source's recorded publisher bytes through that source's own parser,
 * for `processed-field-inventory.test.ts`.
 *
 * One reader per source, total over the inventory's sources: a source whose
 * declaration names a recording must be readable here, or its claim is not
 * checked against anything. `null` is only for a source that names no
 * recording, and the suite fails a `null` reader whose source declares one.
 */

import { panic, Result } from "better-result";
import path from "node:path";

import { parseDocx } from "@stll/folio-core/server";
import { type DocumentAst, isDocumentAst } from "@stll/legal-ast/document-ast";

import { parseCzUohsDocumentPdf } from "@/api/handlers/case-law/ingestion/adapters/cz-uohs";
import { assemblePlNsaDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa";
import { PL_NSA_SNAPSHOT } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import { parseFindokDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-findok";
import { parseNsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-ns";
import { parseNssDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";
import {
  parseRegionalDecision,
  type ParseRegionalInput,
} from "@/api/handlers/case-law/ingestion/parsers/cz-regional";
import { parseUsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-us";
import { parseEcjDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj";
import { parseHuBhgyDecision } from "@/api/handlers/case-law/ingestion/parsers/hu-bhgy";
import {
  parsePlTkPage,
  parsePlTkText,
  readPlTkCasePage,
  readPlTkRuling,
} from "@/api/handlers/case-law/ingestion/parsers/pl-tk";
import { parseSkUsDocumentXhtml } from "@/api/handlers/case-law/ingestion/parsers/sk-us";
import { parseUkFclDecision } from "@/api/handlers/case-law/ingestion/parsers/uk-fcl";
import { loadDocxArchive } from "@/api/lib/docx-archive";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/ingestion-types";
import type { ProcessedFieldSourceKey } from "@/api/lib/legal-search/processed-field-inventory";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

/** One recorded document as its source's parser reads it today. */
export type EvidenceDocument = {
  /** Fixture file, and the decision inside it when it holds several. */
  readonly id: string;
  readonly ast: DocumentAst;
};

export type EvidenceReader = (
  fixture: string,
) => Promise<readonly EvidenceDocument[]>;

/** `apps/api`, the root evidence paths are written against. */
export const API_ROOT = path.join(import.meta.dir, "..", "..", "..");

const bytesOf = async (fixture: string): Promise<Uint8Array> => {
  const bytes = await Bun.file(path.join(API_ROOT, fixture)).bytes();
  return fixture.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes;
};

const textOf = async (fixture: string): Promise<string> =>
  new TextDecoder().decode(await bytesOf(fixture));

const jsonOf = async (fixture: string): Promise<unknown> =>
  JSON.parse(await textOf(fixture));

/** The decisions of a recorded adapter page, each with its stored raw. */
const pageDecisions = async (
  fixture: string,
): Promise<readonly Record<string, unknown>[]> => {
  const recorded = await jsonOf(fixture);
  const page = isRecord(recorded) ? recorded["page"] : undefined;
  const decisions = isRecord(page) ? page["decisions"] : undefined;
  return isUnknownArray(decisions)
    ? decisions.filter(isRecord)
    : panic(`${fixture} holds no recorded page`);
};

const stringOf = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === "string" ? value : panic(`no string ${key}`);
};

const readCzNs: EvidenceReader = async (fixture) =>
  (await pageDecisions(fixture)).map((row) => {
    const parts =
      decodeSourceRawEnvelope(stringOf(row, "sourceRaw")) ??
      panic(`${fixture}: a row without an envelope`);
    return {
      id: `${fixture}#${stringOf(row, "caseNumber")}`,
      ast: parseNsDecisionHtml({
        documentId: stringOf(row, "sourceDocumentId"),
        webUrl: stringOf(row, "sourceUrl"),
        printUrl: stringOf(row, "sourceUrl"),
        webHtml: parts["web"] ?? "",
        printHtml: parts["print"] ?? panic(`${fixture}: no print page`),
      }).documentAst,
    };
  });

const readCzUohs: EvidenceReader = async (fixture) => [
  {
    id: fixture,
    ast: await parseCzUohsDocumentPdf(await bytesOf(fixture), {
      caseNumber: path.basename(fixture),
      sourceUrl: fixture,
    }),
  },
];

const readCzNss: EvidenceReader = async (fixture) => [
  {
    id: fixture,
    ast: parseNssDecisionHtml({
      caseNumber: path.basename(fixture),
      ecli: undefined,
      court: "Nejvyšší správní soud",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      html: await textOf(fixture),
      detailMetadata: {},
    }).documentAst,
  },
];

const parseCzUs = (caseNumber: string, html: string): DocumentAst =>
  parseUsDecisionHtml({
    html,
    caseNumber,
    ecli: undefined,
    court: "Ústavní soud",
    decisionDate: undefined,
    decisionType: undefined,
  }).documentAst;

const readCzUs: EvidenceReader = async (fixture) => {
  if (fixture.endsWith(".html.gz")) {
    return [{ id: fixture, ast: parseCzUs(fixture, await textOf(fixture)) }];
  }
  return (await pageDecisions(fixture)).map((row) => {
    const raw = stringOf(row, "sourceRaw");
    const legacy: unknown = decodeSourceRawEnvelope(raw) ?? JSON.parse(raw);
    const html = isRecord(legacy)
      ? (legacy["document"] ?? legacy["textHtml"])
      : undefined;
    const caseNumber = stringOf(row, "caseNumber");
    return {
      id: `${fixture}#${caseNumber}`,
      ast: parseCzUs(
        caseNumber,
        typeof html === "string" ? html : panic(`${fixture}: no document`),
      ),
    };
  });
};

type FinaldocParagraph = ParseRegionalInput["header"][number];
type FinaldocStyle = ParseRegionalInput["styles"][number];

const isFinaldocParagraph = (value: unknown): value is FinaldocParagraph =>
  isRecord(value) &&
  typeof value["styleLocalId"] === "number" &&
  "tableCellInfo" in value &&
  isUnknownArray(value["texts"]) &&
  value["texts"].every(
    (span) =>
      isRecord(span) &&
      typeof span["text"] === "string" &&
      typeof span["anonStyle"] === "string",
  );

const isFinaldocStyle = (value: unknown): value is FinaldocStyle =>
  isRecord(value) &&
  typeof value["localId"] === "number" &&
  typeof value["alignment"] === "string" &&
  typeof value["hasSpaceBefore"] === "boolean" &&
  typeof value["hasSpaceAfter"] === "boolean" &&
  typeof value["bold"] === "boolean" &&
  typeof value["italic"] === "boolean";

/** A recorded list of the publisher's shape; anything else fails loudly. */
const arrayAt = <T>(
  record: Record<string, unknown>,
  key: string,
  isItem: (value: unknown) => value is T,
): T[] => {
  const value = record[key] ?? [];
  if (!isUnknownArray(value) || !value.every(isItem)) {
    return panic(`finaldoc ${key} is not in the publisher's shape`);
  }
  return [...value];
};

const readCzRegional: EvidenceReader = async (fixture) => {
  const doc = await jsonOf(fixture);
  if (!isRecord(doc)) {
    return panic(`${fixture} is not a finaldoc`);
  }
  const textAt = (key: string) =>
    typeof doc[key] === "string" ? doc[key] : "";
  return [
    {
      id: fixture,
      ast: parseRegionalDecision({
        caseNumber: path.basename(fixture),
        ecli: undefined,
        court: "Okresní soud",
        decisionDate: undefined,
        decisionType: "rozsudek",
        sourceUrl: undefined,
        header: arrayAt(doc, "header", isFinaldocParagraph),
        verdict: arrayAt(doc, "verdict", isFinaldocParagraph),
        justification: arrayAt(doc, "justification", isFinaldocParagraph),
        information: arrayAt(doc, "information", isFinaldocParagraph),
        styles: arrayAt(doc, "styles", isFinaldocStyle),
        verdictText: textAt("verdictText"),
        justificationText: textAt("justificationText"),
      }).documentAst,
    },
  ];
};

const readSkUs: EvidenceReader = async (fixture) => {
  const recorded = await jsonOf(fixture);
  const content = isRecord(recorded) ? recorded["content"] : undefined;
  if (typeof content !== "string") {
    return panic(`${fixture} holds no content`);
  }
  return [
    {
      id: fixture,
      ast: parseSkUsDocumentXhtml({
        xhtml: Buffer.from(content, "base64").toString("utf-8"),
        caseNumber: path.basename(fixture),
        ecli: undefined,
        court: "Ústavný súd Slovenskej republiky",
        decisionDate: undefined,
        decisionType: undefined,
        documentUrl: "https://www.ustavnysud.sk/",
      }).documentAst,
    },
  ];
};

const readEuEcj: EvidenceReader = async (fixture) => [
  {
    id: fixture,
    ast: parseEcjDecisionHtml({
      caseNumber: path.basename(fixture),
      ecli: undefined,
      court: "Court of Justice",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      celex: path.basename(fixture).split(".")[0] ?? "",
      html: await textOf(fixture),
    }).documentAst,
  },
];

const readHuBhgy: EvidenceReader = async (fixture) => {
  const bytes = await bytesOf(fixture);
  return [
    {
      id: fixture,
      ast: parseHuBhgyDecision({
        document: await parseDocx(bytes.slice().buffer, {
          detectVariables: false,
          preloadFonts: false,
        }),
        listedCaseNumber: path.basename(fixture),
        court: "Kúria",
        sourceUrl: "https://eakta.birosag.hu/anonimizalt-hatarozatok",
        documentUrl: "https://eakta.birosag.hu/hatarozat-letoltes/",
        documentId: path.basename(fixture),
        statutes: [],
      }).documentAst,
    },
  ];
};

const readPlTk: EvidenceReader = async (fixture) => {
  const html = await textOf(fixture);
  const parsedPage = parsePlTkPage(html);
  const page =
    readPlTkCasePage(parsedPage) ?? panic(`${fixture} is not a case page`);
  return page.rulingIds.flatMap((rulingId) => {
    const ruling = readPlTkRuling(parsedPage, rulingId);
    if (ruling?.textHtml === undefined) {
      return [];
    }
    return [
      {
        id: `${fixture}#${rulingId}`,
        ast: parsePlTkText({
          page: parsedPage,
          caseNumber: path.basename(fixture),
          court: "Trybunał Konstytucyjny",
          decisionDate: undefined,
          decisionType: undefined,
          documentId: rulingId,
          sourceUrl: "https://ipo.trybunal.gov.pl/",
          documentUrl: undefined,
          textHtml: ruling.textHtml,
        }).documentAst,
      },
    ];
  });
};

const readPlNsa: EvidenceReader = async (fixture) => {
  const recorded = await jsonOf(fixture);
  const shard =
    PL_NSA_SNAPSHOT.shards[0] ?? panic("the pinned revision has no shard");
  return (isUnknownArray(recorded) ? recorded : [])
    .filter(isRecord)
    .flatMap((entry) => {
      const values = entry["values"];
      const row = entry["row"];
      if (!isRecord(values) || typeof row !== "number") {
        return [];
      }
      const built = assemblePlNsaDecision({
        source: values,
        position: { shard, row },
        snapshot: PL_NSA_SNAPSHOT,
      });
      const ast = built.decision.documentAst;
      return isDocumentAst(ast)
        ? [{ id: `${fixture}#${String(entry["case"])}`, ast }]
        : [];
    });
};

const readAtFindok: EvidenceReader = async (fixture) => {
  const archive = await loadDocxArchive(await bytesOf(fixture), {
    maxEntries: 20,
    maxEntryBytes: 4_000_000,
    maxTotalBytes: 4_000_000,
  });
  const xml =
    (await archive.readEntryString("Gesamt/152649.Entscheidungstext.xml")) ??
    panic(`${fixture} holds no decision text`);
  const parsed = parseFindokDecisionXml({
    caseNumber: path.basename(fixture),
    court: "Bundesfinanzgericht",
    decisionDate: "2026-01-01",
    decisionType: "Erkenntnis",
    sourceDocumentId: path.basename(fixture),
    sourceUrl: "https://findok.bmf.gv.at/",
    xml,
  });
  if (Result.isError(parsed)) {
    return panic(`${fixture}: ${parsed.error.message}`);
  }
  return [{ id: fixture, ast: parsed.value.documentAst }];
};

/** Every source's reader, or `null` where its declaration names no recording. */
export const PROCESSED_FIELD_EVIDENCE_READERS = {
  "cz-regional": readCzRegional,
  "cz-ns": readCzNs,
  "cz-nss": readCzNss,
  "cz-us": readCzUs,
  "cz-uohs": readCzUohs,
  "sk-courts": null,
  "sk-us": readSkUs,
  "pl-courts": null,
  "pl-sn": null,
  "pl-kio": null,
  "pl-tk": readPlTk,
  "pl-nsa": readPlNsa,
  "pl-ncourt": null,
  "at-courts": null,
  "at-vfgh": null,
  "at-vwgh": null,
  "at-bvwg": null,
  "at-lvwg": null,
  "at-asylgh": null,
  "at-ubas": null,
  "at-uvs": null,
  "at-verg": null,
  "at-umse": null,
  "at-bks": null,
  "at-findok": readAtFindok,
  "eu-ecj": readEuEcj,
  "hu-bhgy": readHuBhgy,
  "uk-fcl": async (fixture) => [
    {
      id: fixture,
      ast: parseUkFclDecision({
        xml: await textOf(fixture),
        documentId: "d-00000000-0000-4000-8000-000000000001",
        sourceUrl:
          "https://caselaw.nationalarchives.gov.uk/d-00000000-0000-4000-8000-000000000001",
      }).unwrap().documentAst,
    },
  ],
  "pl-kis": null,
  "pl-uodo": null,
  "pl-uokik": null,
  "us-courtlistener": null,
} as const satisfies Record<ProcessedFieldSourceKey, EvidenceReader | null>;
