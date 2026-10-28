import { Result } from "better-result";
import { desc, eq } from "drizzle-orm";

import { DECISION_TEXT_WITHHELD_REASON } from "@stll/api-contract/case-law-text-field";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawMatterLinks } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { capabilityRoute } from "@/api/lib/capability-route";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readDecisionHeadnote } from "@/api/lib/case-law/decision-text";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { readMatterLinkDecisions } from "@/api/lib/case-law/matter-link-decisions";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import {
  decisionTextWithheldReason,
  isRedistributable,
} from "@/api/lib/legal-search/corpus-source";
import { LIMITS } from "@/api/lib/limits";

const MATTER_LINKS_LIST_CAPABILITY = "case-law.matter-links.list";

type MatterLinkAudience = "human" | "model";

type ListMatterLinksProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  /** The public corpus gate the language versions are read through. */
  caseLawDb: CaseLawPublicReadDb;
  audience?: MatterLinkAudience;
};

export const listMatterLinksHandler = async ({
  caseLawDb,
  scopedDb,
  workspaceId,
  audience = "human",
}: ListMatterLinksProps) => {
  const links = await scopedDb((tx) =>
    tx
      .select()
      .from(caseLawMatterLinks)
      .where(eq(caseLawMatterLinks.workspaceId, workspaceId))
      .orderBy(desc(caseLawMatterLinks.createdAt), desc(caseLawMatterLinks.id))
      .limit(LIMITS.caseLawMatterLinksPerWorkspace),
  );
  const [decisions, withdrawal] = await Promise.all([
    readMatterLinkDecisions(
      caseLawDb,
      links.map((row) => row.decisionId),
    ),
    readWithdrawnCopyProjection({ values: links, caseLawDb }),
  ]);
  const decisionsById = new Map(decisions.map((row) => [row.decisionId, row]));

  // The versions of each linked decision, through the same helper the search
  // hit uses: a multilingual decision the client cannot tell apart from a
  // monolingual one loses the language segment of its route, and the slug
  // lookup then resolves whichever translation matches.
  const alternatesByGroupKey =
    await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys: [
        ...new Set(
          decisions
            .map((row) => row.languageGroupKey)
            .filter((value): value is string => value !== null),
        ),
      ],
    });

  return {
    links: links
      .map((link) => {
        const marker = withdrawal.marker(null, link.decisionId);
        if (marker !== null) {
          return {
            ...link,
            decision: { status: "withdrawn" as const, marker },
          };
        }
        const detail = decisionsById.get(link.decisionId);
        if (detail === undefined) {
          return null;
        }
        const row = { ...detail, ...link };
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
          id: row.id,
          decisionId: row.decisionId,
          note: row.note,
          linkedBy: row.linkedBy,
          createdAt: row.createdAt,
          decision: {
            status: "available" as const,
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
      })
      .filter((link) => link !== null),
  };
};

const config = {
  contract: "patch",
  description:
    "List the case-law decisions linked to the current matter, newest link " +
    "first, each with its note and the decision's row facts: case number, " +
    "slug, ECLI, court, country, language, the decision's other language " +
    "versions, date, type, citation count and headnote preview. Returns the " +
    "whole set up to the per-matter link cap; there is no pagination. " +
    "Withdrawn decisions return only a translated marker beside the saved note.",
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

const listMatterLinks = createSafeHandler(
  config,
  async function* ({ route, scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listMatterLinksHandler({
            workspaceId,
            scopedDb,
            caseLawDb: caseLawPublicReadDb,
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

export default listMatterLinks;
