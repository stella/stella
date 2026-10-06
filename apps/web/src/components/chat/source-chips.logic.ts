import { isBusinessRegistrySlug } from "@stll/api-contract";
import {
  isCaseLawDecisionId,
  parseCaseLawDecisionPath,
} from "@stll/api-contract/case-law-decision-route";
import { parseStatutePath } from "@stll/api-contract/statute-route";

import type { ChatToolCallPart } from "@/components/chat/chat-ui-tools";
import type {
  BusinessRegistrySourceReference,
  CaseLawDecisionSourceReference,
  ExternalSourceReference,
} from "@/components/chat/external-source-store";
import { decisionCitationCourtLabel } from "@/features/case-law/components/decision-citation-chip.logic";
import type { ChatMessage, ChatSourceDocument } from "@/lib/api-contract";
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

  // A root-relative URL is only a source when it opens a legal reader page.
  if (safeHref.startsWith("/")) {
    const { pathname } = new URL(safeHref, "https://app.invalid");
    return (
      parseStatutePath(pathname) !== null ||
      parseCaseLawDecisionPath(pathname) !== null
    );
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

const getBusinessRegistryReference = (
  value: Record<string, unknown>,
  sourceUrl: string,
): BusinessRegistrySourceReference | undefined => {
  const registry = value["registry"];
  const companyId = value["id"];
  const registryUrl = value["registryUrl"];
  if (
    !isBusinessRegistrySlug(registry) ||
    typeof companyId !== "string" ||
    companyId.trim().length === 0 ||
    companyId.trim().length > 256 ||
    registryUrl !== sourceUrl
  ) {
    return undefined;
  }
  return { registry, companyId: companyId.trim() };
};

/**
 * A case-law tool result names the decision by its stella id beside the
 * publisher's URL. The id is stella's only when the tool is: a connector's
 * `decisionId` is its own, so the caller drops this for connector output.
 */
const getCaseLawDecisionReference = (
  value: Record<string, unknown>,
): CaseLawDecisionSourceReference | undefined => {
  const decisionId = value["decisionId"];
  const caseNumber = value["caseNumber"];
  if (
    typeof decisionId !== "string" ||
    !isCaseLawDecisionId(decisionId) ||
    typeof caseNumber !== "string" ||
    caseNumber.trim().length === 0
  ) {
    return undefined;
  }
  const court = value["court"];
  const country = value["country"];
  const date = value["decisionDate"];
  const abbreviation = getStringField(value, ["courtAbbreviation"]);
  const ecli = value["ecli"];
  const citation =
    typeof court === "string" &&
    court.trim().length > 0 &&
    typeof country === "string" &&
    country.trim().length > 0 &&
    (typeof date === "string" || date === null)
      ? {
          court,
          courtShortCode: decisionCitationCourtLabel({
            court,
            country,
            courtAbbreviation: abbreviation,
            ecli: typeof ecli === "string" ? ecli : null,
          }),
          decisionDate: date,
        }
      : undefined;
  return {
    caseNumber: caseNumber.trim(),
    decisionId: decisionId.trim(),
    ...(citation === undefined ? {} : { citation }),
  };
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

  const appUrl = getStringField(value, ["appUrl"]);
  const publisherUrl = getStringField(value, ["source_url", "sourceUrl"]);
  const url = getStringField(value, [
    "url",
    "source_url",
    "sourceUrl",
    "appUrl",
    "pdfUrl",
    "rtfUrl",
    "registryUrl",
  ]);
  if (isHttpUrl(url)) {
    const safeUrl = sanitizeHref(url);
    if (safeUrl) {
      sources.push({
        appUrl: appUrl !== undefined ? sanitizeHref(appUrl) : undefined,
        sourceUrl:
          publisherUrl !== undefined && isHttpUrl(publisherUrl)
            ? sanitizeHref(publisherUrl)
            : undefined,
        businessRegistry: getBusinessRegistryReference(value, url),
        caseLawDecision: getCaseLawDecisionReference(value),
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
          ]) ?? (safeUrl.startsWith("/") ? safeUrl : new URL(safeUrl).hostname),
        provider: getStringField(value, [
          "provider",
          "source",
          "authority",
          "courtCode",
          "idx",
          "registry",
        ]),
        snippet: getStringField(value, ["snippet", "summary", "description"]),
        text: getTextField(value, ["text", "content", "body", "texts"]),
      });
    }
  }

  for (const child of Object.values(value)) {
    collectExternalSources(child, sources, depth + 1);
  }
};

export const dedupeExternalSources = (
  sources: readonly ExternalSourceEntry[],
): ExternalSourceEntry[] => {
  const sourcesByUrl = new Map<string, ExternalSourceEntry>();
  for (const source of sources) {
    const existing = sourcesByUrl.get(source.url);
    sourcesByUrl.set(
      source.url,
      existing
        ? {
            appUrl: source.appUrl ?? existing.appUrl,
            sourceUrl: source.sourceUrl ?? existing.sourceUrl,
            businessRegistry:
              source.businessRegistry ?? existing.businessRegistry,
            caseLawDecision: source.caseLawDecision ?? existing.caseLawDecision,
            connectorSlug: source.connectorSlug ?? existing.connectorSlug,
            iconHref: source.iconHref ?? existing.iconHref,
            provider: source.provider ?? existing.provider,
            snippet: source.snippet ?? existing.snippet,
            sourceToolName: source.sourceToolName ?? existing.sourceToolName,
            text: source.text ?? existing.text,
            title: source.title,
            url: source.url,
          }
        : source,
    );
  }
  return Array.from(sourcesByUrl.values());
};

type McpToolInfo = {
  connectorSlug: string;
  sourceToolName: string;
};

const getToolOutput = (part: ChatMessage["parts"][number]): unknown => {
  if (part.type !== "tool-call" || !("output" in part)) {
    return undefined;
  }

  return part.output;
};

const getMcpToolInfo = (part: ChatToolCallPart): McpToolInfo | null => {
  const sourceToolName = part.name;
  if (!sourceToolName.startsWith("mcp__")) {
    return null;
  }

  const [, connectorSlug, ...toolParts] = sourceToolName.split("__");
  if (!connectorSlug || toolParts.length === 0) {
    return null;
  }

  return { connectorSlug, sourceToolName };
};

export const collectSourceChipEntries = ({
  parts,
  sourceDocuments = [],
}: {
  parts: ChatMessage["parts"];
  sourceDocuments?: readonly ChatSourceDocument[] | undefined;
}): {
  uniqueExternalSources: ExternalSourceEntry[];
  uniqueSources: SourceDocumentEntry[];
} => {
  const sources: SourceDocumentEntry[] = [];
  const externalSources: ExternalSourceEntry[] = [];
  for (const sourceDocument of sourceDocuments) {
    sources.push({ data: sourceDocument });
  }

  for (const part of parts) {
    if (part.type !== "tool-call") {
      continue;
    }

    const toolOutput = getToolOutput(part);
    collectSourceDocuments(toolOutput, sources);
    const mcpToolInfo = getMcpToolInfo(part);
    const toolExternalSources: ExternalSourceEntry[] = [];
    collectExternalSources(toolOutput, toolExternalSources);
    for (const source of toolExternalSources) {
      externalSources.push({
        ...source,
        caseLawDecision: mcpToolInfo ? undefined : source.caseLawDecision,
        appUrl: mcpToolInfo ? undefined : source.appUrl,
        sourceUrl: mcpToolInfo ? undefined : source.sourceUrl,
        connectorSlug: source.connectorSlug ?? mcpToolInfo?.connectorSlug,
        sourceToolName: source.sourceToolName ?? mcpToolInfo?.sourceToolName,
      });
    }
  }

  const seen = new Set<string>();
  const uniqueSources = sources.filter(({ data }) => {
    const key = `${data.workspaceId ?? ""}:${data.entityId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return {
    uniqueExternalSources: dedupeExternalSources(externalSources),
    uniqueSources,
  };
};
