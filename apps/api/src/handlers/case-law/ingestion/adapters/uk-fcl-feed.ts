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
const PARSER_VERSION = 2;
const invalid = (message: string) =>
  new ParseXmlError({ message, cause: undefined });
const children = (node: slimdom.Element) => Array.from(node.children);
const named = (node: slimdom.Element, namespace: string, name: string) =>
  children(node).filter(
    (child) => child.namespaceURI === namespace && child.localName === name,
  );
const onlyText = (node: slimdom.Element, namespace: string, name: string) => {
  const matches = named(node, namespace, name);
  return matches.length === 1 ? matches[0]?.textContent?.trim() : undefined;
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
    return Result.err(
      invalid("Feed entry requires a single valid tna:uri document identity"),
    );
  }
  if (!updated || !contentHash || !/^[a-fA-F0-9]{64}$/u.test(contentHash)) {
    return Result.err(
      invalid(
        "Feed entry requires updated and a 64-digit hexadecimal tna:contenthash",
      ),
    );
  }
  const timestamp = Result.try({
    try: () => Temporal.Instant.from(updated),
    catch: (cause) =>
      new ParseXmlError({
        message: "Feed entry updated must be a valid timestamp with an offset",
        cause,
      }),
  });
  if (timestamp.isErr()) {
    return Result.err(timestamp.error);
  }
  const identifiers = named(entry, TNA, "identifier").map((identifier) => ({
    type: identifier.getAttribute("type"),
    slug: identifier.getAttribute("slug"),
    value: identifier.textContent?.trim() ?? "",
  }));
  const neutralIdentifiers = identifiers.filter(({ type }) => type === "ukncn");
  const neutral = neutralIdentifiers.at(0);
  if (neutralIdentifiers.length !== 1 || !neutral?.value) {
    return Result.err(
      invalid(
        "Feed entry requires exactly one nonempty ukncn identifier to verify the judgment citation",
      ),
    );
  }
  const fields = new Map<
    string,
    { text: string; attributes: Record<string, string> }[]
  >();
  for (const child of entry.getElementsByTagNameNS("*", "*")) {
    const value = {
      text: child.textContent ?? "",
      // Namespace declarations are serialization, not data: an archived
      // single entry repeats them on children, the published page does not.
      attributes: Object.fromEntries(
        Array.from(child.attributes)
          .filter(
            ({ namespaceURI }) =>
              namespaceURI !== "http://www.w3.org/2000/xmlns/",
          )
          .map(({ name, value: attribute }) => [name, attribute]),
      ),
    };
    const label = `{${child.namespaceURI ?? ""}}${child.localName}`;
    const group = fields.get(label);
    if (group === undefined) {
      fields.set(label, [value]);
    } else {
      group.push(value);
    }
  }
  return Result.ok({
    sourceDocumentId,
    updated,
    contentHash,
    identifiers,
    caseNumber: neutral.value,
    courtSlug: neutral.slug?.split("/").slice(0, -2).join("/"),
    fields: Object.fromEntries(fields),
  });
};

const parseUkFclFeed = (raw: string) => {
  const parsed = Result.try({
    try: () => slimdom.parseXmlDocument(raw),
    catch: (cause) =>
      new ParseXmlError({
        message: "Atom feed XML could not be parsed",
        cause,
      }),
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const document = parsed.value;
  const root = document.documentElement;
  if (
    document.doctype !== null ||
    root === null ||
    root.namespaceURI !== ATOM ||
    root.localName !== "feed"
  ) {
    return Result.err(
      invalid("Expected an Atom feed root without a document type declaration"),
    );
  }
  const readEntries = Result.all(named(root, ATOM, "entry").map(readEntry));
  if (readEntries.isErr()) {
    return Result.err(readEntries.error);
  }
  const entries = readEntries.value;
  if (
    new Set(entries.map(({ sourceDocumentId }) => sourceDocumentId)).size !==
    entries.length
  ) {
    return Result.err(
      invalid("Feed contains duplicate tna:uri document identities"),
    );
  }
  const links = named(root, ATOM, "link").filter(
    (link) => link.getAttribute("rel") === "next",
  );
  if (links.length > 1) {
    return Result.err(invalid("Feed must contain at most one next page link"));
  }
  const href = links.at(0)?.getAttribute("href");
  if (href === null) {
    return Result.err(invalid("Next page link requires an href attribute"));
  }
  if (href === undefined) {
    return Result.ok({ entries, next: null, root });
  }
  const resolved = Result.try({
    try: () => new URL(href, ORIGIN),
    catch: (cause) =>
      new ParseXmlError({
        message: "Next page href could not be parsed as a URL",
        cause,
      }),
  });
  if (resolved.isErr()) {
    return Result.err(resolved.error);
  }
  const next = restrictOutboundUrl({
    rawUrl: resolved.value.toString(),
    hostPolicy: { type: "exact-origin", origins: [ORIGIN] },
    pathPrefixes: ["/atom.xml"],
  });
  if (next === null) {
    return Result.err(
      invalid("Next page href must target the publisher's /atom.xml feed"),
    );
  }
  return Result.ok({ entries, next: next.toString(), root });
};

export const readUkFclFeed = (raw: string, perPage: number) => {
  if (!Number.isSafeInteger(perPage) || perPage < 1) {
    return Result.err(
      invalid("Requested per_page must be a positive safe integer"),
    );
  }
  const parsed = parseUkFclFeed(raw);
  if (parsed.isErr()) {
    return parsed;
  }
  const { entries, next } = parsed.value;
  if (next === null && entries.length >= perPage) {
    return Result.err(
      invalid(
        "Feed end not proven: a full page has no next link; retry the page and inspect the publisher's pagination before advancing the cursor",
      ),
    );
  }
  return Result.ok({ entries, next });
};

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
  const listed = parseUkFclFeed(feed);
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
  if (entry.caseNumber !== caseNumber) {
    return Result.err(invalid("Feed and document citations differ"));
  }
  const entryElement = named(listed.value.root, ATOM, "entry").find(
    (item) => onlyText(item, TNA, "uri") === sourceDocumentId,
  );
  if (entryElement === undefined) {
    return Result.err(invalid("Document identity absent from feed"));
  }
  const listingDocument = new slimdom.Document();
  const listingFeed = listingDocument.createElementNS(ATOM, "feed");
  listingDocument.append(listingFeed);
  // Serializing the imported subtree materializes inherited namespace bindings.
  listingFeed.append(listingDocument.importNode(entryElement, true));
  const listing = slimdom.serializeToWellFormedString(listingDocument);
  const sourceRaw = encodeSourceRawEnvelope({ listing, document });
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
      detail: built.error.message,
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
