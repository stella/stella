import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { declareFingerprintFields } from "@stll/errors";
import { createSha256 } from "@stll/sha256/bun";

import { decodeEuCellarBytes } from "@/api/handlers/legislation/ingestion/eu-cellar-bytes";
import {
  parseEuCellarMetadata,
  validCellarIri,
} from "@/api/handlers/legislation/ingestion/eu-cellar-metadata";
import { parseEuCellarNotice } from "@/api/handlers/legislation/ingestion/eu-cellar-notice";
import { classifyEuResourceType } from "@/api/handlers/legislation/ingestion/eu-resource-type";
import { parseEuXhtml } from "@/api/handlers/legislation/ingestion/eu-xhtml";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";

import { EU_CELLAR_LIMITS } from "./eu-cellar-limits";

const EXPRESSION_MANIFESTED_BY =
  "http://publications.europa.eu/ontology/cdm#expression_manifested_by_manifestation";

class EuCellarDocumentError extends TaggedError("EuCellarDocumentError")<{
  message: string;
  reason:
    | "unsupported-format"
    | "unsupported-type"
    | "manifestation"
    | "identity"
    | "malformed-snapshot";
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type EuCellarDocumentOptions = {
  sourceId: LegislationDocumentInput["sourceId"];
  noticeXml: string;
  /** A consolidation's base Work notice; the publisher must state their relation. */
  baseNoticeXml?: string;
  manifestationIri: string;
  itemIri: string;
  content: { type: "xhtml"; html: string } | { type: "formex" | "archive" };
  origin: NonNullable<LegislationDocumentInput["origin"]>;
  /** Original byte fingerprints accompany decoded snapshots for exact replay identity. */
  transport?: Record<
    string,
    { sha256: string; charset: string; source: string }
  >;
};

const itemDownloadUrl = (manifestationIri: string, itemIri: string) => {
  if (!validCellarIri(manifestationIri)) {
    return null;
  }
  const url = URL.parse(itemIri);
  if (url === null) {
    return null;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.href.startsWith(`${manifestationIri}/`)
  ) {
    return null;
  }
  url.protocol = "https:";
  return url.href;
};

/** One observed expression becomes one canonical legislation input, without IO. */
export const parseEuCellarDocument = ({
  sourceId,
  noticeXml,
  baseNoticeXml,
  manifestationIri,
  itemIri,
  content,
  origin,
  transport,
}: EuCellarDocumentOptions) => {
  if (content.type !== "xhtml") {
    return Result.err(
      new EuCellarDocumentError({
        message: "This EU manifestation format is not supported",
        reason: "unsupported-format",
      }),
    );
  }
  const notice = parseEuCellarNotice(noticeXml);
  if (notice.isErr()) {
    return Result.err(notice.error);
  }
  const base =
    baseNoticeXml === undefined ? notice : parseEuCellarNotice(baseNoticeXml);
  if (base.isErr()) {
    return Result.err(base.error);
  }
  const metadata = parseEuCellarMetadata({
    workIri: base.value.workIri,
    textWorkIri: notice.value.workIri,
    expressionIri: notice.value.expressionIri,
    response: {
      results: {
        bindings:
          baseNoticeXml === undefined
            ? notice.value.response.results.bindings
            : [
                ...base.value.response.results.bindings,
                ...notice.value.response.results.bindings,
              ],
      },
    },
  });
  if (metadata.isErr()) {
    return Result.err(metadata.error);
  }
  const fact = metadata.value;
  const publisherCelexType = fact.celexTypes.at(0);
  const classification = classifyEuResourceType({
    resourceType: fact.resourceType,
    ...(publisherCelexType === undefined ? {} : { publisherCelexType }),
  });
  if (classification.type === "soft-law") {
    return Result.ok(classification);
  }
  if (classification.type === "unsupported") {
    return Result.err(
      new EuCellarDocumentError({
        message: "Unsupported EU resource type",
        reason: "unsupported-type",
      }),
    );
  }
  const manifestations = notice.value.manifestations.filter(
    (entry) => entry.iri === manifestationIri,
  );
  const belongsToExpression = fact.statements.some(
    ({ s, p, o }) =>
      s.type === "uri" &&
      s.value === fact.expressionIri &&
      p.value === EXPRESSION_MANIFESTED_BY &&
      o.type === "uri" &&
      o.value === manifestationIri,
  );
  const manifestation = manifestations.at(0);
  if (
    !belongsToExpression ||
    manifestations.length !== 1 ||
    manifestation?.type !== "xhtml" ||
    manifestation.items.length !== 1 ||
    manifestation.items.at(0) !== itemIri
  ) {
    return Result.err(
      new EuCellarDocumentError({
        message: "The notice must state this single-item XHTML manifestation",
        reason: "manifestation",
      }),
    );
  }
  const documentUrl = itemDownloadUrl(manifestationIri, itemIri);
  if (documentUrl === null) {
    return Result.err(
      new EuCellarDocumentError({
        message: "Manifestation item is outside its CELLAR resource",
        reason: "identity",
      }),
    );
  }
  const celex = fact.celex.at(0);
  if (celex === undefined) {
    return Result.err(
      new EuCellarDocumentError({
        message: "The Work has no stated CELEX identifier",
        reason: "identity",
      }),
    );
  }
  const sourceUrl = `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${encodeURIComponent(celex)}`;
  const text = parseEuXhtml({
    html: content.html,
    source: {
      system: "eur-lex",
      documentId: fact.expressionIri,
      webUrl: sourceUrl,
      printUrl: documentUrl,
    },
  });
  if (text.isErr()) {
    return Result.err(text.error);
  }
  const observation = {
    schema: "eu-cellar-document-v1",
    noticeXml,
    ...(baseNoticeXml === undefined ? {} : { baseNoticeXml }),
    manifestationIri,
    itemIri,
    content,
    ...(transport === undefined ? {} : { transport }),
  };
  const hash = createSha256();
  hash.update(JSON.stringify(observation));
  const observationFingerprint = hash.digest("hex");
  const sourceRaw = JSON.stringify({ ...observation, observationFingerprint });
  const document = {
    sourceId,
    eli: fact.workIri,
    identifiers: fact.identifiers,
    title: fact.title,
    country: "EU",
    language: "en",
    documentType: classification.documentType,
    status: "unknown",
    effectiveDate: null,
    // Neither a file's date nor an in-force flag establishes a wording window.
    version: {
      type: "invalid-window",
      validFrom: null,
      end: { type: "open" },
      basis: "missing-start",
    },
    expression: {
      publisherId: `cellar:${fact.expressionIri}`,
      kind: fact.expressionKind,
    },
    origin,
    fulltext: text.value.fulltext,
    ast: text.value.documentAst,
    sourceUrl,
    documentUrl,
    metadata: {
      publisherEvidence: fact.publisherEvidence,
      cellar: {
        textWorkIri: fact.textWorkIri,
        celex: fact.celex,
        resourceType: fact.resourceType,
        subtype: classification.subtype,
        statements: fact.statements,
      },
    },
    sourceRaw,
    sourceRawContentType: "application/json",
    rawHash: observationFingerprint,
  } as const satisfies LegislationDocumentInput;
  return Result.ok({ type: "document" as const, document });
};

type CellarBytePayload = { bytes: Uint8Array; contentType: string | null };
type ParseEuCellarDocumentBytesOptions = Omit<
  EuCellarDocumentOptions,
  "noticeXml" | "baseNoticeXml" | "content" | "transport"
> & {
  notice: CellarBytePayload;
  baseNotice?: CellarBytePayload;
  content: CellarBytePayload;
};

/** Live acquisition enters through bytes; stored snapshots use the text entry. */
export const parseEuCellarDocumentBytes = ({
  notice,
  baseNotice,
  content,
  ...identity
}: ParseEuCellarDocumentBytesOptions) => {
  const decodedNotice = decodeEuCellarBytes({ ...notice, kind: "notice" });
  if (decodedNotice.isErr()) {
    return Result.err(decodedNotice.error);
  }
  const decodedBase =
    baseNotice === undefined
      ? null
      : decodeEuCellarBytes({ ...baseNotice, kind: "notice" });
  if (decodedBase?.isErr() === true) {
    return Result.err(decodedBase.error);
  }
  const decodedContent = decodeEuCellarBytes({ ...content, kind: "xhtml" });
  if (decodedContent.isErr()) {
    return Result.err(decodedContent.error);
  }
  const { text: noticeXml, ...noticeTransport } = decodedNotice.value;
  const { text: html, ...contentTransport } = decodedContent.value;
  const base = decodedBase?.isOk() === true ? decodedBase.value : undefined;
  return parseEuCellarDocument({
    ...identity,
    noticeXml,
    ...(base === undefined ? {} : { baseNoticeXml: base.text }),
    content: { type: "xhtml", html },
    transport: {
      notice: noticeTransport,
      content: contentTransport,
      ...(base === undefined
        ? {}
        : {
            baseNotice: {
              sha256: base.sha256,
              charset: base.charset,
              source: base.source,
            },
          }),
    },
  });
};

const fingerprintSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));
const snapshotSchema = v.strictObject({
  schema: v.literal("eu-cellar-document-v1"),
  observationFingerprint: fingerprintSchema,
  noticeXml: v.string(),
  baseNoticeXml: v.optional(v.string()),
  manifestationIri: v.string(),
  itemIri: v.string(),
  content: v.strictObject({ type: v.literal("xhtml"), html: v.string() }),
  transport: v.optional(
    v.record(
      v.string(),
      v.strictObject({
        sha256: fingerprintSchema,
        charset: v.string(),
        source: v.string(),
      }),
    ),
  ),
});

type ReparseEuCellarDocumentOptions = {
  sourceId: LegislationDocumentInput["sourceId"];
  raw: string;
};

/** Pipeline sanitization may change text, so replay retains the observed fingerprint. */
export const reparseEuCellarDocument = ({
  sourceId,
  raw,
}: ReparseEuCellarDocumentOptions) => {
  if (Buffer.byteLength(raw, "utf-8") > EU_CELLAR_LIMITS.rawSnapshotBytes) {
    return Result.err(
      new EuCellarDocumentError({
        message: "EU raw snapshot exceeds its limit",
        reason: "malformed-snapshot",
      }),
    );
  }
  const json = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: (cause) =>
      new EuCellarDocumentError({
        message: "EU raw snapshot is not JSON",
        reason: "malformed-snapshot",
        cause,
      }),
  });
  if (json.isErr()) {
    return Result.err(json.error);
  }
  const parsed = v.safeParse(snapshotSchema, json.value);
  if (!parsed.success) {
    return Result.err(
      new EuCellarDocumentError({
        message: "EU raw snapshot has an unsupported shape",
        reason: "malformed-snapshot",
      }),
    );
  }
  const snapshot = parsed.output;
  const result = parseEuCellarDocument({
    sourceId,
    noticeXml: snapshot.noticeXml,
    manifestationIri: snapshot.manifestationIri,
    itemIri: snapshot.itemIri,
    content: snapshot.content,
    origin: "stored-raw-replay",
    ...(snapshot.baseNoticeXml === undefined
      ? {}
      : { baseNoticeXml: snapshot.baseNoticeXml }),
    ...(snapshot.transport === undefined
      ? {}
      : { transport: snapshot.transport }),
  });
  if (result.isErr()) {
    return Result.err(result.error);
  }
  if (result.value.type !== "document") {
    return result;
  }
  return Result.ok({
    type: "document" as const,
    document: {
      ...result.value.document,
      sourceRaw: raw,
      rawHash: snapshot.observationFingerprint,
    },
  });
};
