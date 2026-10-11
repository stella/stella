import { panic, Result } from "better-result";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { isPublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { DECISION_TEXT_WITHHELD_REASON } from "@stll/api-contract/case-law-text-field";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawMatterLinks,
  caseLawSources,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { capabilityRoute } from "@/api/lib/capability-route";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readDecisionHeadnote } from "@/api/lib/case-law/decision-text";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import {
  publisherHeadnoteMetadataSql,
  publisherKeywordsMetadataSql,
} from "@/api/lib/case-law/publisher-summary";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  decisionTextWithheldReason,
  isRedistributable,
} from "@/api/lib/legal-search/corpus-source";
import { LIMITS } from "@/api/lib/limits";
import {
  admitLawRead,
  type LawReadAdmission,
} from "@/api/lib/usage/law-read-admission";

const MATTER_LINKS_LIST_CAPABILITY = "case-law.matter-links.list";

type MatterLinkAudience = "human" | "model";

type ReadMatterLinkDecisionsOptions = {
  admission: LawReadAdmission;
  caseLawDb: CaseLawPublicReadDb;
  decisionIds: SafeId<"caseLawDecision">[];
  audience: MatterLinkAudience;
};

const readMatterLinkDecisions = async ({
  caseLawDb,
  decisionIds,
  audience,
}: ReadMatterLinkDecisionsOptions) => {
  const fetched = await caseLawDb(
    async (tx) =>
      await readBounded(
        tx
          .select({
            decisionId: caseLawDecisions.id,
            caseNumber: caseLawDecisions.caseNumber,
            slug: caseLawDecisions.slug,
            ecli: caseLawDecisions.ecli,
            court: caseLawDecisions.court,
            country: caseLawDecisions.country,
            language: caseLawDecisions.language,
            languageGroupKey: caseLawDecisions.languageGroupKey,
            decisionDate: caseLawDecisions.decisionDate,
            decisionType: caseLawDecisions.decisionType,
            citationCount: caseLawDecisions.citationCount,
            descriptor: caseLawSources.descriptor,
            // Publisher text follows the source's terms, exactly as the search
            // hit does: a source that withholds redistribution contributes the
            // row's own facts and no borrowed prose.
            headnote: sql<
              string | null
            >`CASE WHEN ${redistributableCaseLawSource}
          THEN ${publisherHeadnoteMetadataSql(caseLawDecisions.metadata)}
        END`,
            keywords: sql<
              string[] | null
            >`CASE WHEN ${redistributableCaseLawSource}
          THEN ${publisherKeywordsMetadataSql(caseLawDecisions.metadata)}
        END`,
          })
          .from(caseLawDecisions)
          .innerJoin(
            caseLawSources,
            eq(caseLawSources.id, caseLawDecisions.sourceId),
          )
          .where(
            and(
              inArray(caseLawDecisions.id, decisionIds),
              publishedCaseLawDecision,
            ),
          ),
        LIMITS.caseLawMatterLinksPerWorkspace,
      ),
  );
  if (fetched.type === "overflow") {
    return panic(
      "Matter link decision hydration exceeded the workspace link cap",
    );
  }
  const rows = fetched.rows.filter((row) =>
    isPublicCaseLawCountry(row.country),
  );

  // The versions of each linked decision, through the same helper the search
  // hit uses: a multilingual decision the client cannot tell apart from a
  // monolingual one loses the language segment of its route, and the slug
  // lookup then resolves whichever translation matches.
  const alternatesByGroupKey =
    await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys: [
        ...new Set(
          rows
            .map((row) => row.languageGroupKey)
            .filter((value): value is string => value !== null),
        ),
      ],
    });

  return {
    links: rows.map((row) => {
      const textWithheldReason =
        !isRedistributable(row.descriptor) ||
        decisionTextWithheldReason(row.descriptor) !== null
          ? DECISION_TEXT_WITHHELD_REASON.SOURCE_LICENCE
          : null;
      const headnote = readDecisionHeadnote({
        headnote: row.headnote,
        keywords: row.keywords,
      });
      const shared = {
        decision: {
          type: "read" as const,
          id: row.decisionId,
          caseNumber: row.caseNumber,
          slug: row.slug,
          ecli: row.ecli,
          court: row.court,
          country: row.country,
          language: row.language,
          languageAlternates: alternatesByGroupKey.alternatesFor(
            row.languageGroupKey,
          ),
          decisionDate: row.decisionDate,
          decisionType: row.decisionType,
          citationCount: row.citationCount,
        },
      };
      if (audience === "human") {
        return {
          ...shared,
          decision: { ...shared.decision, headnote },
        };
      }
      return {
        ...shared,
        decision: {
          ...shared.decision,
          headnote: textWithheldReason === null ? headnote : null,
          textWithheldReason,
        },
      };
    }),
  };
};

type ListMatterLinksProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  caseLawDb: CaseLawPublicReadDb;
  audience?: MatterLinkAudience;
  admit?: typeof admitLawRead;
};

export const listMatterLinksHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
  caseLawDb,
  audience = "human",
  admit = admitLawRead,
}: ListMatterLinksProps) => {
  const links = await scopedDb(
    async (tx) =>
      await tx
        .select({
          id: caseLawMatterLinks.id,
          decisionId: caseLawMatterLinks.decisionId,
          note: caseLawMatterLinks.note,
          linkedBy: caseLawMatterLinks.linkedBy,
          createdAt: caseLawMatterLinks.createdAt,
        })
        .from(caseLawMatterLinks)
        .where(eq(caseLawMatterLinks.workspaceId, workspaceId))
        .orderBy(
          desc(caseLawMatterLinks.createdAt),
          desc(caseLawMatterLinks.id),
        )
        .limit(LIMITS.caseLawMatterLinksPerWorkspace),
  );
  if (links.length === 0) {
    return { links: [] };
  }
  const admitted = await admit({ organizationId });
  if (Result.isError(admitted)) {
    return {
      links: links.map((link) => ({
        ...link,
        decision: { type: "refused" as const, code: admitted.error.type },
      })),
    };
  }
  const decisions = await readMatterLinkDecisions({
    admission: admitted.value,
    caseLawDb,
    decisionIds: links.map((link) => link.decisionId),
    audience,
  });
  const byId = new Map(
    decisions.links.map(({ decision }) => [decision.id, decision]),
  );
  return {
    links: links.map((link) => ({
      ...link,
      decision: byId.get(link.decisionId) ?? { type: "not_found" as const },
    })),
  };
};

const config = {
  lawRead: "conditional",
  description:
    "List the case-law decisions linked to the current matter, newest link " +
    "first, each with its note and the decision's row facts: case number, " +
    "slug, ECLI, court, country, language, the decision's other language " +
    "versions, date, type, citation count and headnote preview. Returns the " +
    "whole set up to the per-matter link cap; there is no pagination. " +
    "Decision payloads require law admission; refusal returns type refused and code not_entitled, missing_scope or access_unavailable while link records remain readable.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "both",
    reason: "legal_corpus_admin",
    consumesServices: false,
  },
  access: "read",
} satisfies WorkspaceHandlerConfig;

type CreateListMatterLinksHandlerOptions = {
  caseLawDb: CaseLawPublicReadDb;
  admit: typeof admitLawRead;
};

export const createListMatterLinksHandler = ({
  caseLawDb,
  admit,
}: CreateListMatterLinksHandlerOptions) =>
  createSafeHandler(
    config,
    async function* ({ route, scopedDb, workspaceId, session }) {
      const response = yield* Result.await(
        Result.tryPromise(
          async () =>
            await listMatterLinksHandler({
              organizationId: session.activeOrganizationId,
              workspaceId,
              scopedDb,
              caseLawDb,
              admit,
              audience:
                route === capabilityRoute(MATTER_LINKS_LIST_CAPABILITY)
                  ? "model"
                  : "human",
            }),
        ),
      );

      return Result.ok(response);
    },
  );

export default createListMatterLinksHandler({
  caseLawDb: caseLawPublicReadDb,
  admit: admitLawRead,
});
