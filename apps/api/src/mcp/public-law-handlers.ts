import type { readGatedDecisionCitations } from "@/api/handlers/case-law/decisions/citation-passages";
import type { readGatedDecisionWithDocument } from "@/api/handlers/case-law/decisions/get-deferred-document";
import type { lookupDecisionsByIdentity } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import type {
  resolveStatuteExpression,
  resolveStatuteWorkVersion,
} from "@/api/handlers/legislation/by-eli";
import type { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import type { readProvisionHistoryHandler } from "@/api/handlers/legislation/provision-history";
import type { readLegislationProvisionVersions } from "@/api/handlers/legislation/provision-versions";
import type { searchLegislationHandler } from "@/api/handlers/legislation/search";
import type { listStatuteVersionsHandler } from "@/api/handlers/legislation/versions";

/**
 * The public-law read seams, in one place.
 *
 * Each entry is the production binding of a corpus handler, deferred to first
 * call so importing a tool module does not pull the handler graph in, and
 * overridable through `McpRequestContext.testDependencies`. They live here
 * rather than beside one tool module because three modules now reach the same
 * corpus (`stella-tools.ts`, `legislation-tools.ts`, and the
 * OpenAI-compatible pair in `compat-corpus.ts`): a second copy of a binding
 * is a second seam tests would have to know about.
 */
export const defaultSearchDecisionsHandler: typeof searchDecisionsHandler =
  async (input, database) =>
    await (
      await import("@/api/handlers/case-law/decisions/search")
    ).searchDecisionsHandler(input, database);

export const defaultReadGatedDecisionWithDocument: typeof readGatedDecisionWithDocument =
  async (input) =>
    await (
      await import("@/api/handlers/case-law/decisions/get-deferred-document")
    ).readGatedDecisionWithDocument(input);

export const defaultReadGatedDecisionCitations: typeof readGatedDecisionCitations =
  async (input) =>
    await (
      await import("@/api/handlers/case-law/decisions/citation-passages")
    ).readGatedDecisionCitations(input);

export const defaultLookupDecisionsByIdentity: typeof lookupDecisionsByIdentity =
  async (input) =>
    await (
      await import("@/api/handlers/case-law/decisions/lookup-by-identity")
    ).lookupDecisionsByIdentity(input);

export const defaultSearchLegislationHandler: typeof searchLegislationHandler =
  async (body, legislationDb) =>
    await (
      await import("@/api/handlers/legislation/search")
    ).searchLegislationHandler(body, legislationDb);

export const defaultResolveStatuteExpression: typeof resolveStatuteExpression =
  async (query, legislationDb) =>
    await (
      await import("@/api/handlers/legislation/by-eli")
    ).resolveStatuteExpression(query, legislationDb);

export const defaultResolveStatuteWorkVersion: typeof resolveStatuteWorkVersion =
  async (query, legislationDb) =>
    await (
      await import("@/api/handlers/legislation/by-eli")
    ).resolveStatuteWorkVersion(query, legislationDb);

export const defaultReadPublicLegislationHandler: typeof readPublicLegislationHandler =
  async (documentId, legislationDb) =>
    await (
      await import("@/api/handlers/legislation/get")
    ).readPublicLegislationHandler(documentId, legislationDb);

export const defaultListStatuteVersionsHandler: typeof listStatuteVersionsHandler =
  async (options) =>
    await (
      await import("@/api/handlers/legislation/versions")
    ).listStatuteVersionsHandler(options);

export const defaultReadProvisionHistoryHandler: typeof readProvisionHistoryHandler =
  async (options) =>
    await (
      await import("@/api/handlers/legislation/provision-history")
    ).readProvisionHistoryHandler(options);

export const defaultReadLegislationProvisionVersions: typeof readLegislationProvisionVersions =
  async (options) =>
    await (
      await import("@/api/handlers/legislation/provision-versions")
    ).readLegislationProvisionVersions(options);

/**
 * The shape guards over those seams' results.
 *
 * Each corpus handler answers either its payload or a status envelope, and
 * every caller has to tell the two apart the same way: a guard per seam, here,
 * so the compat pair and the named tools cannot disagree about what a success
 * looks like.
 */
export type SearchCaseLawSuccess = Extract<
  Awaited<ReturnType<typeof searchDecisionsHandler>>,
  { hits: unknown[] }
>;

export const isSearchCaseLawSuccess = (
  value: Awaited<ReturnType<typeof searchDecisionsHandler>>,
): value is SearchCaseLawSuccess =>
  typeof value === "object" && "hits" in value && Array.isArray(value.hits);

export type ReadCaseLawDecisionSuccess = Extract<
  NonNullable<Awaited<ReturnType<typeof readGatedDecisionWithDocument>>>,
  { caseNumber: string; citationsFrom: unknown[]; citationsTo: unknown[] }
>;

export const isReadCaseLawDecisionSuccess = (
  value: NonNullable<Awaited<ReturnType<typeof readGatedDecisionWithDocument>>>,
): value is ReadCaseLawDecisionSuccess =>
  typeof value === "object" &&
  "caseNumber" in value &&
  typeof value.caseNumber === "string" &&
  "citationsFrom" in value &&
  Array.isArray(value.citationsFrom) &&
  "citationsTo" in value &&
  Array.isArray(value.citationsTo);

export type LegislationSearchSuccess = Extract<
  Awaited<ReturnType<typeof searchLegislationHandler>>,
  { items: unknown[] }
>;

export const isLegislationSearchSuccess = (
  value: Awaited<ReturnType<typeof searchLegislationHandler>>,
): value is LegislationSearchSuccess =>
  typeof value === "object" && "items" in value && Array.isArray(value.items);

export type StatuteDocument = Extract<
  Awaited<ReturnType<typeof readPublicLegislationHandler>>,
  { eli: string }
>;

export const isStatuteDocument = (
  value: Awaited<ReturnType<typeof readPublicLegislationHandler>>,
): value is StatuteDocument =>
  typeof value === "object" && "eli" in value && typeof value.eli === "string";
