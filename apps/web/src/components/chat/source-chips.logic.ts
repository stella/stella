import type { ChatSourceDocument } from "@stll/api/types";

import type { ExternalSourceReference } from "@/components/chat/external-source-store";
import { sanitizeHref } from "@/lib/sanitize-href";

export type SourceDocumentEntry = {
  data: ChatSourceDocument;
  id?: string | undefined;
};

export type ExternalSourceEntry = ExternalSourceReference;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

type ParsedJsonContainer = Record<string, unknown> | unknown[];

const parseJsonLikeString = (
  value: string,
): ParsedJsonContainer | undefined => {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 2_000_000 ||
    (trimmed.at(0) !== "{" && trimmed.at(0) !== "[")
  ) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) || isRecord(parsed)) {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }

  const safeHref = sanitizeHref(value);
  if (!safeHref) {
    return false;
  }

  try {
    const url = new URL(safeHref);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const getStringField = (
  value: Record<string, unknown>,
  fields: readonly string[],
): string | undefined => {
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
};

const getTextField = (
  value: Record<string, unknown>,
  fields: readonly string[],
): string | undefined => {
  for (const field of fields) {
    const candidate = value[field];
    const text = collectTextValue(candidate);
    if (text) {
      return text;
    }
  }
  return undefined;
};

const buildAresCompanyText = (
  value: Record<string, unknown>,
): string | undefined => {
  const ico = getStringField(value, ["ico"]);
  const name = getStringField(value, ["name", "obchodniJmeno"]);
  const registryUrl = getStringField(value, ["registryUrl"]);
  if (!ico || !name || !registryUrl) {
    return undefined;
  }

  const lines = [name, `IČO: ${ico}`];
  pushLabelledAresField(lines, "Právní forma", value, [
    "legalForm",
    "pravniForma",
  ]);
  appendAresAddress(lines, value["address"]);
  pushLabelledAresField(lines, "Datum vzniku", value, ["dateEstablished"]);
  appendAresCourtFile(lines, value["courtFile"]);
  pushLabelledAresField(lines, "Základní kapitál", value, ["shareCapital"]);
  pushLabelledAresField(lines, "Jednání", value, ["actingClause"]);
  appendAresStatutoryBodies(lines, value["statutoryBodies"]);

  return lines.join("\n");
};

const pushLabelledAresField = (
  lines: string[],
  label: string,
  value: Record<string, unknown>,
  fields: readonly string[],
) => {
  const fieldValue = getStringField(value, fields);
  if (fieldValue) {
    lines.push(`${label}: ${fieldValue}`);
  }
};

const appendAresAddress = (lines: string[], address: unknown) => {
  if (!isRecord(address)) {
    return;
  }

  const textAddress = getStringField(address, ["textAddress", "textovaAdresa"]);
  if (textAddress) {
    lines.push(`Sídlo: ${textAddress}`);
  }
};

const appendAresCourtFile = (lines: string[], courtFile: unknown) => {
  if (!isRecord(courtFile)) {
    return;
  }

  const court = getStringField(courtFile, ["court"]);
  const section = getStringField(courtFile, ["section"]);
  const insert = getStringField(courtFile, ["insert"]);
  if (court && section && insert) {
    lines.push(`Spisová značka: ${section} ${insert}, ${court}`);
  }
};

const appendAresStatutoryBodies = (lines: string[], bodies: unknown) => {
  if (!Array.isArray(bodies) || bodies.length === 0) {
    return;
  }

  lines.push("Statutární orgány:");
  for (const body of bodies) {
    appendAresStatutoryBody(lines, body);
  }
};

const appendAresStatutoryBody = (lines: string[], body: unknown) => {
  if (!isRecord(body)) {
    return;
  }

  const organName = getStringField(body, ["organName"]);
  if (organName) {
    lines.push(`- ${organName}`);
  }

  const members = body["members"];
  if (!Array.isArray(members)) {
    return;
  }

  for (const member of members) {
    appendAresBodyMember(lines, member);
  }
};

const appendAresBodyMember = (lines: string[], member: unknown) => {
  if (!isRecord(member)) {
    return;
  }

  const memberName = getStringField(member, ["name"]);
  if (!memberName) {
    return;
  }

  const role = getStringField(member, ["role"]);
  lines.push(`  - ${memberName}${role ? ` (${role})` : ""}`);
};

const collectTextValue = (value: unknown, depth = 0): string | undefined => {
  if (depth > 4) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const text = collectTextValue(item, depth + 1);
      if (text) {
        parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const preferred = getStringField(value, [
    "_combined",
    "markdown",
    "text",
    "content",
    "body",
    "html",
  ]);
  if (preferred) {
    return preferred;
  }

  const parts: string[] = [];
  for (const child of Object.values(value)) {
    const text = collectTextValue(child, depth + 1);
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
};

const isChatSourceDocument = (value: unknown): value is ChatSourceDocument => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["entityId"] === "string" &&
    typeof value["kind"] === "string" &&
    (typeof value["mimeType"] === "string" || value["mimeType"] === null) &&
    typeof value["title"] === "string" &&
    (typeof value["workspaceId"] === "string" || value["workspaceId"] === null)
  );
};

export const collectSourceDocuments = (
  value: unknown,
  sources: SourceDocumentEntry[],
  depth = 0,
) => {
  if (depth > 6) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSourceDocuments(item, sources, depth + 1);
    }
    return;
  }

  if (typeof value === "string") {
    const parsed = parseJsonLikeString(value);
    if (parsed !== undefined) {
      collectSourceDocuments(parsed, sources, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const sourceDocument = value["sourceDocument"];
  if (isChatSourceDocument(sourceDocument)) {
    sources.push({ data: sourceDocument });
  }

  for (const child of Object.values(value)) {
    collectSourceDocuments(child, sources, depth + 1);
  }
};

export const collectExternalSources = (
  value: unknown,
  sources: ExternalSourceEntry[],
  depth = 0,
) => {
  if (depth > 6 || sources.length >= 20) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectExternalSources(item, sources, depth + 1);
    }
    return;
  }

  if (typeof value === "string") {
    const parsed = parseJsonLikeString(value);
    if (parsed !== undefined) {
      collectExternalSources(parsed, sources, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const url = getStringField(value, [
    "url",
    "sourceUrl",
    "pdfUrl",
    "rtfUrl",
    "registryUrl",
  ]);
  if (isHttpUrl(url)) {
    const safeUrl = sanitizeHref(url);
    if (safeUrl) {
      sources.push({
        url: safeUrl,
        title:
          getStringField(value, [
            "title",
            "name",
            "label",
            "citation",
            "caseNumber",
            "ecli",
            "cite_as",
          ]) ?? new URL(safeUrl).hostname,
        provider: getStringField(value, [
          "provider",
          "source",
          "authority",
          "courtCode",
          "idx",
        ]),
        snippet: getStringField(value, ["snippet", "summary", "description"]),
        text:
          getTextField(value, ["text", "content", "body", "texts"]) ??
          buildAresCompanyText(value),
      });
    }
  }

  for (const child of Object.values(value)) {
    collectExternalSources(child, sources, depth + 1);
  }
};
