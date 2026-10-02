import type { ScopedDb } from "@/api/db/safe-db";
import type { PracticeJurisdiction } from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * The jurisdictions the organization says it practises in, as onboarding and
 * `set_practice_jurisdictions` recorded them.
 *
 * One reader for every surface: the MCP onboarding next step asks for them
 * when they are missing, the OpenAI-compatible `search` (which takes a query
 * and nothing else) uses them to rank the corpus countries it asks, never to
 * exclude one, the desktop picks its default registry from them, and the
 * sanctions check reads which lists bind the firm. Two readers would be two
 * answers to "what does this firm practise".
 *
 * The codes are ISO 3166-1 alpha-2, which is what the column stores; a corpus
 * keyed on alpha-3 converts at its own boundary.
 */
export const loadPracticeJurisdictions = async ({
  scopedDb,
  organizationId,
}: {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
}): Promise<readonly PracticeJurisdiction[]> => {
  const row = await scopedDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: { practiceJurisdictions: true },
    }),
  );
  return arrayOrEmpty(row?.practiceJurisdictions);
};
