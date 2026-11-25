import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import { chatBrowserSiteNotes } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { SITE_NOTES_TOOL_SET } from "@/api/mcp/site-notes-tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";

type ReadFixture = Awaited<ReturnType<typeof seedEntityReadScaling>>;

const SITE = "https://research.example.org";

// The member's other websites stay within the per-member caps however large
// the fixture: at most 90 websites with a few notes each.
const OTHER_SITES = 90;

/**
 * `read_site_notes` reads one website's notes: the member keeps one note for
 * it beside `size` notes for other websites, which the read must not walk.
 */
export const measureReadSiteNotesTool = async ({
  db,
  organizationId,
  safeDb,
  size,
  userId,
}: ReadFixture) => {
  const rows = [
    {
      id: createSafeId<"chatBrowserSiteNote">(),
      organizationId,
      userId,
      origin: SITE,
      kind: "works" as const,
      step: "search form",
      text: "The advanced form filters by court and date.",
    },
    ...Array.from({ length: size }, (_, index) => ({
      id: createSafeId<"chatBrowserSiteNote">(),
      organizationId,
      userId,
      origin: `https://other-${String(index % OTHER_SITES)}.example.org`,
      kind: "works" as const,
      step: `step ${String(index)}`,
      text: `How step ${String(index)} works on the website.`,
    })),
  ];
  await db.insert(chatBrowserSiteNotes).values(rows);
  try {
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response: unknown =
        await SITE_NOTES_TOOL_SET.handlers.read_site_notes({
          args: { url: `${SITE}/search` },
          context: asTestRaw<
            Parameters<
              typeof SITE_NOTES_TOOL_SET.handlers.read_site_notes
            >[0]["context"]
          >({ organizationId, safeDb, userId }),
        });
      const payload: unknown =
        isRecord(response) && response["status"] === "success"
          ? response["data"]
          : undefined;
      if (!isRecord(payload) || !isUnknownArray(payload["notes"])) {
        return panic("read_site_notes scaling requires a successful response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(payload)),
        rows: payload["notes"].length,
      };
    });
  } finally {
    await db.delete(chatBrowserSiteNotes).where(
      inArray(
        chatBrowserSiteNotes.id,
        rows.map(({ id }) => id),
      ),
    );
  }
};
