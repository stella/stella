import { Result } from "better-result";

import { isBusinessRegistrySlug } from "@stll/api-contract";
import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import {
  isCaseLawDecisionId,
  parseCaseLawDecisionPath,
} from "@stll/api-contract/case-law-decision-route";
import { parseStatutePath } from "@stll/api-contract/statute-route";
import { unwrapUntrustedContentFence } from "@stll/api-contract/untrusted-content-fence";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Temporal } from "@stll/time";

import {
  chatAnswerCitationHrefs,
  chatAnswerDecisionTargets,
  chatAnswerMarkdownDocuments,
  citationUrlKey,
} from "@/components/chat/chat-decision-citations.logic";
import type { ChatToolCallPart } from "@/components/chat/chat-ui-tools";
import type {
  BusinessRegistrySourceReference,
  CaseLawDecisionSourceReference,
  ExternalSourceReference,
} from "@/components/chat/external-source-store";
import { decisionCitationCourtLabel } from "@/components/references/decision-citation-chip.logic";
import { entityReferenceHref } from "@/components/references/reference.logic";
import type { ChatMessage, ChatSourceDocument } from "@/lib/api-contract";

export type SourceDocumentEntry = {
  data: ChatSourceDocument;
  id?: string | undefined;
};

type CaseLawSourceMetadata = {
  caseNumber: string;
  court: string;
  courtShortCode: string;
  decisionDate?: string | null | undefined;
  decisionId?: string | undefined;
  holding?: string | undefined;
  tier: CourtTierLabel;
};

export type ExternalSourceEntry = ExternalSourceReference & {
  caseLaw?: CaseLawSourceMetadata | undefined;
};

export type SourceChipEntry =
  | {
      relation: "cited" | "consulted";
      type: "document";
      source: SourceDocumentEntry;
    }
  | {
      relation: "cited" | "consulted";
      type: "external";
      source: ExternalSourceEntry;
    }
  | {
      relation: "cited" | "consulted";
      type: "case-law";
      source: ExternalSourceEntry;
      caseLaw: CaseLawSourceMetadata;
    };

const CZECH_COURT_TIER_BY_SHORT_CODE = {
  ÚS: "constitutional",
  NS: "supreme",
  NSS: "supreme",
  VS: "regional",
  KS: "regional",
  MS: "other",
  OS: "other",
} as const satisfies Readonly<Record<string, CourtTierLabel>>;

const czechCourtTiers: ReadonlyMap<string, CourtTierLabel> = new Map(
  Object.entries(CZECH_COURT_TIER_BY_SHORT_CODE),
);

export const courtTierForSource = (courtShortCode: string): CourtTierLabel =>
  czechCourtTiers.get(courtShortCode) ?? "other";

const isCourtTierLabel = (value: unknown): value is CourtTierLabel =>
  typeof value === "string" && COURT_TIER_LABELS.some((tier) => tier === value);

export const sortCourtTiers = (tiers: readonly CourtTierLabel[]) =>
  tiers.toSorted(
    (left, right) =>
      COURT_TIER_LABELS.indexOf(left) - COURT_TIER_LABELS.indexOf(right),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

type ParsedJsonContainer = Record<string, unknown> | unknown[];

const parseJsonLikeString = (
  value: string,
): ParsedJsonContainer | undefined => {
  // External connector results arrive fenced as untrusted data; the payload
  // between the delimiters is what may carry JSON.
  const trimmed = (unwrapUntrustedContentFence(value) ?? value).trim();
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

const getDateField = (
  value: Record<string, unknown>,
  fields: readonly string[],
): string | undefined => {
  const date = getStringField(value, fields);
  if (date === undefined) {
    return undefined;
  }
  // The row formats through `Date`, which rejects annotated Temporal forms
  // ("2026-01-02[u-ca=iso8601]"), so a valid date is kept in its plain ISO
  // form and anything else is dropped.
  const plainDate = Result.try(() => Temporal.PlainDate.from(date));
  if (Result.isOk(plainDate)) {
    return plainDate.value.toString({ calendarName: "never" });
  }
  const instant = Result.try(() => Temporal.Instant.from(date));
  return Result.isOk(instant) ? instant.value.toString() : undefined;
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

const collectSourceDocuments = (
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

  const publisherUrl = getStringField(value, ["source_url", "sourceUrl"]);
  const url = getStringField(value, [
    "url",
    "source_url",
    "sourceUrl",
    "pdfUrl",
    "rtfUrl",
    "registryUrl",
  ]);
  if (isHttpUrl(url)) {
    const safeUrl = sanitizeHref(url);
    if (safeUrl) {
      const caseNumber = getStringField(value, ["caseNumber"]);
      const court = getStringField(value, ["court"]);
      const courtShortCode =
        getStringField(value, ["courtAbbreviation", "courtCode"]) ??
        (court === undefined
          ? undefined
          : decisionCitationCourtLabel({
              court,
              country: getStringField(value, ["country"]) ?? "",
              courtAbbreviation: undefined,
              ecli: getStringField(value, ["ecli"]) ?? null,
            }));
      const holding = getTextField(value, [
        "headnote",
        "legalSentence",
        "summary",
        "abstract",
      ]);
      sources.push({
        ...(caseNumber !== undefined &&
        court !== undefined &&
        courtShortCode !== undefined
          ? {
              caseLaw: {
                caseNumber,
                court,
                courtShortCode,
                decisionDate: getDateField(value, ["decisionDate", "date"]),
                decisionId: getStringField(value, ["decisionId"]),
                holding,
                tier: isCourtTierLabel(value["courtTier"])
                  ? value["courtTier"]
                  : courtTierForSource(courtShortCode),
              },
            }
          : {}),
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
    let caseLaw = source.caseLaw;
    if (caseLaw === undefined) {
      caseLaw = existing?.caseLaw;
    } else if (existing?.caseLaw !== undefined) {
      // A later hit for the same decision may omit what an earlier one
      // carried; every optional field keeps the value it already had.
      caseLaw = {
        ...existing.caseLaw,
        ...caseLaw,
        decisionDate: caseLaw.decisionDate ?? existing.caseLaw.decisionDate,
        decisionId: caseLaw.decisionId ?? existing.caseLaw.decisionId,
        holding: caseLaw.holding ?? existing.caseLaw.holding,
      };
    }
    sourcesByUrl.set(
      source.url,
      existing
        ? {
            sourceUrl: source.sourceUrl ?? existing.sourceUrl,
            businessRegistry:
              source.businessRegistry ?? existing.businessRegistry,
            caseLawDecision: source.caseLawDecision ?? existing.caseLawDecision,
            caseLaw,
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
  appOrigins,
  parts,
  sourceDocuments = [],
}: {
  /** Origins whose links are Stella pages; relative answer links resolve
   *  against them, so a cited in-app route is matched to its source. */
  appOrigins: ReadonlySet<string>;
  parts: ChatMessage["parts"];
  sourceDocuments?: readonly ChatSourceDocument[] | undefined;
}): {
  entries: SourceChipEntry[];
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
  const uniqueExternalSources = dedupeExternalSources(externalSources);
  const markdownDocuments = chatAnswerMarkdownDocuments({ parts });
  const hrefs = new Set(markdownDocuments.flatMap(chatAnswerCitationHrefs));
  const decisionIds = new Set(
    chatAnswerDecisionTargets({
      markdownDocuments,
      sources: uniqueExternalSources,
      appOrigins,
    }).flatMap((target) => (target.type === "id" ? [target.decisionId] : [])),
  );
  const isLinked = (urls: readonly (string | undefined)[]) =>
    urls.some(
      (url) =>
        url !== undefined &&
        [...hrefs].some(
          (href) =>
            citationUrlKey(url, appOrigins) ===
            citationUrlKey(href, appOrigins),
        ),
    );
  const entries: SourceChipEntry[] = [];
  for (const source of uniqueSources) {
    const canonicalHref =
      source.data.workspaceId === null
        ? undefined
        : entityReferenceHref({
            entityId: source.data.entityId,
            matterId: source.data.workspaceId,
          });
    entries.push({
      relation: isLinked([
        canonicalHref,
        source.data.entityRef,
        source.data.mention,
      ])
        ? "cited"
        : "consulted",
      type: "document",
      source,
    });
  }
  for (const source of uniqueExternalSources) {
    const relation =
      isLinked([source.url, source.sourceUrl]) ||
      [source.caseLaw?.decisionId, source.caseLawDecision?.decisionId].some(
        (decisionId) => decisionId !== undefined && decisionIds.has(decisionId),
      )
        ? "cited"
        : "consulted";
    if (source.caseLaw !== undefined) {
      entries.push({
        relation,
        type: "case-law",
        source,
        caseLaw: source.caseLaw,
      });
    } else {
      entries.push({ relation, type: "external", source });
    }
  }
  return {
    entries,
    uniqueExternalSources,
    uniqueSources,
  };
};
