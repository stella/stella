import { Result } from "better-result";
import * as slimdom from "slimdom";

import { Temporal } from "@stll/time";

import { ParseXmlError } from "@/api/handlers/case-law/ingestion/parsers/parse-xml-error";
import { parseUkFclDecision } from "@/api/handlers/case-law/ingestion/parsers/uk-fcl";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import {
  absentDecisionTextFields,
  checkedDecisionMetadata,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  isPersistableSourceDocumentId,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/lib/legal-search/ingestion-types";
import type {
  StoredRawReparseInput,
  StoredRawReparseOutcome,
} from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/source-raw-envelope";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

const ATOM = "http://www.w3.org/2005/Atom";
const TNA = "https://caselaw.nationalarchives.gov.uk";
const ORIGIN = "https://caselaw.nationalarchives.gov.uk";
const PARSER_VERSION = 1;
const invalid = (message: string) =>
  new ParseXmlError({ message, cause: undefined });
const children = (node: slimdom.Element) => Array.from(node.children);
const named = (node: slimdom.Element, namespace: string, name: string) =>
  children(node).filter(
    (child) => child.namespaceURI === namespace && child.localName === name,
  );
const onlyText = (node: slimdom.Element, namespace: string, name: string) => {
  const matches = named(node, namespace, name);
  return matches.length === 1 ? matches[0]?.textContent.trim() : undefined;
};
const readEntry = (entry: slimdom.Element) => {
  const sourceDocumentId = onlyText(entry, TNA, "uri");
  const updated = onlyText(entry, ATOM, "updated");
  const contentHash = onlyText(entry, TNA, "contenthash");
  if (
    !sourceDocumentId ||
    !isPersistableSourceDocumentId(sourceDocumentId) ||
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(sourceDocumentId)
  ) {
    throw invalid("Invalid feed document identity");
  }
  if (!updated || !contentHash || !/^[a-fA-F0-9]{64}$/u.test(contentHash)) {
    throw invalid("Invalid feed version fields");
  }
  Temporal.Instant.from(updated);
  const identifiers = named(entry, TNA, "identifier").map((identifier) => ({
    type: identifier.getAttribute("type"),
    slug: identifier.getAttribute("slug"),
    value: identifier.textContent.trim(),
  }));
  const neutral = identifiers.find(({ type }) => type === "ukncn");
  const fields = new Map<
    string,
    { text: string; attributes: Record<string, string> }[]
  >();
  for (const child of entry.getElementsByTagNameNS("*", "*")) {
    const value = {
      text: child.textContent,
      attributes: Object.fromEntries(
        Array.from(child.attributes, ({ name, value: attribute }) => [
          name,
          attribute,
        ]),
      ),
    };
    const label = `{${child.namespaceURI}}${child.localName}`;
    const group = fields.get(label);
    if (group === undefined) {
      fields.set(label, [value]);
    } else {
      group.push(value);
    }
  }
  return {
    sourceDocumentId,
    updated,
    contentHash,
    identifiers,
    caseNumber: neutral?.value,
    courtSlug: neutral?.slug?.split("/").slice(0, -2).join("/"),
    fields: Object.fromEntries(fields),
  };
};

export const readUkFclFeed = (raw: string) =>
  Result.try({
    try: () => {
      const document = slimdom.parseXmlDocument(raw);
      const root = document.documentElement;
      if (
        document.doctype !== null ||
        root.namespaceURI !== ATOM ||
        root.localName !== "feed"
      ) {
        throw invalid("Invalid Atom feed");
      }
      const entries = named(root, ATOM, "entry").map(readEntry);
      if (
        new Set(entries.map(({ sourceDocumentId }) => sourceDocumentId))
          .size !== entries.length
      ) {
        throw invalid("Duplicate feed document identity");
      }
      const links = named(root, ATOM, "link").filter(
        (link) => link.getAttribute("rel") === "next",
      );
      if (links.length > 1) {
        throw invalid("Ambiguous next feed page");
      }
      const href = links.at(0)?.getAttribute("href");
      if (href === null) {
        throw invalid("Missing next feed URL");
      }
      const next =
        href === undefined
          ? null
          : restrictOutboundUrl({
              rawUrl: new URL(href, ORIGIN).toString(),
              hostPolicy: { type: "exact-origin", origins: [ORIGIN] },
              pathPrefixes: ["/atom.xml"],
            });
      if (href !== undefined && next === null) {
        throw invalid("Invalid next feed URL");
      }
      return { entries, next: next?.toString() ?? null };
    },
    catch: (cause) =>
      new ParseXmlError({ message: "Unreadable Atom feed", cause }),
  });

type BuildUkFclDecisionOptions = {
  feed: string;
  document: string;
  sourceDocumentId: string;
};
export const buildUkFclDecision = ({
  feed,
  document,
  sourceDocumentId,
}: BuildUkFclDecisionOptions) => {
  const listed = readUkFclFeed(feed);
  if (listed.isErr()) {
    return listed;
  }
  const entry = listed.value.entries.find(
    (item) => item.sourceDocumentId === sourceDocumentId,
  );
  if (entry === undefined) {
    return Result.err(invalid("Document identity absent from feed"));
  }
  const sourceUrl = `${ORIGIN}/${sourceDocumentId}`;
  const parsed = parseUkFclDecision({
    xml: document,
    documentId: sourceDocumentId,
    sourceUrl,
  });
  if (parsed.isErr()) {
    return parsed;
  }
  const {
    caseNumber,
    court,
    decisionDate,
    judges,
    fulltext,
    documentAst,
    sections,
    caseName,
    metadata,
  } = parsed.value;
  if (entry.caseNumber !== undefined && entry.caseNumber !== caseNumber) {
    return Result.err(invalid("Feed and document citations differ"));
  }
  const sourceRaw = encodeSourceRawEnvelope({ listing: feed, document });
  return Result.ok(
    plainTextIngestionResult({
      caseNumber,
      sourceDocumentId,
      court,
      country: "GBR",
      language: "en",
      decisionDate,
      judges,
      fulltext,
      documentAst,
      sections,
      sourceUrl,
      documentUrl: `${sourceUrl}/data.xml`,
      metadata: checkedDecisionMetadata({
        ...metadata,
        feedFields: entry.fields,
        identifiers: entry.identifiers,
        contentHash: entry.contentHash,
        updated: entry.updated,
        courtSlug: entry.courtSlug,
        caseName,
        ecli: { type: "absent", reason: "not_published" },
      }),
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      sourceRaw,
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      rawHash: sourceFingerprint({ sourceRaw }),
      parserVersion: PARSER_VERSION,
    }),
  );
};

export const reparseUkFclStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  const parts = decodeSourceRawEnvelope(new TextDecoder().decode(stored.raw));
  if (
    parts?.["listing"] === undefined ||
    parts["document"] === undefined ||
    stored.contentType !== SOURCE_RAW_ENVELOPE_CONTENT_TYPE
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: "Missing stored XML envelope",
    };
  }
  if (stored.sourceDocumentId === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: "Missing publisher identity",
    };
  }
  const built = buildUkFclDecision({
    feed: parts["listing"],
    document: parts["document"],
    sourceDocumentId: stored.sourceDocumentId,
  });
  if (built.isErr()) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: "Stored XML cannot rebuild the judgment",
    };
  }
  if (built.value.caseNumber !== stored.caseNumber) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: "Stored citation differs",
    };
  }
  return { type: "parsed", result: built.value };
};
