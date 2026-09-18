import type { PracticeJurisdiction } from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import type { McpRequestContext } from "@/api/mcp/context";

/**
 * The jurisdictions the organization says it practises in, as onboarding and
 * `set_practice_jurisdictions` recorded them.
 *
 * One reader for the whole MCP surface: the onboarding hint asks for them when
 * they are missing, and the OpenAI-compatible `search` (which takes a query
 * and nothing else) uses them to decide which corpus countries a query is
 * about. Two readers would be two answers to "what does this firm practise".
 *
 * The codes are ISO 3166-1 alpha-2, which is what the column stores; a corpus
 * keyed on alpha-3 converts at its own boundary.
 */
export const loadPracticeJurisdictions = async (
  context: McpRequestContext,
): Promise<readonly PracticeJurisdiction[]> => {
  const row = await context.scopedDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: context.organizationId } },
      columns: { practiceJurisdictions: true },
    }),
  );
  return arrayOrEmpty(row?.practiceJurisdictions);
};
