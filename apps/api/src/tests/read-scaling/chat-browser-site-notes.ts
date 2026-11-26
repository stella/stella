import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import { chatBrowserSiteNotes } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import listBrowserSiteNotes from "@/api/handlers/chat/browser-site-notes/list";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  queryCountLogger,
  runWithMeasuredQueryCounter,
} from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  type TestDatabase,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

/** The member's own website notes: the list, the same at every size. */
export const BROWSER_SITE_NOTES_PAGE = 5;

type SeedOptions = {
  organizationId: SafeId<"organization">;
  otherUserId: SafeId<"user">;
  userId: SafeId<"user">;
  /** A colleague's website notes, which the read must not walk. */
  size: number;
};

const note = (
  owner: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
  prefix: string,
  index: number,
) => ({
  id: createSafeId<"chatBrowserSiteNote">(),
  ...owner,
  origin: `https://${prefix}-${String(index % 50).padStart(2, "0")}.example.com`,
  kind: "works" as const,
  step: `step ${String(index)}`,
  text: `How step ${String(index)} works on the website.`,
});

/**
 * Seeds the member's five website notes beside `size` notes of a colleague in
 * the same organization, so the population the read must not walk grows
 * while the member's list stays five rows long.
 */
export const seedBrowserSiteNotesScaling = async (
  database: TestDatabase,
  { organizationId, otherUserId, userId, size }: SeedOptions,
) => {
  const rows = [
    ...Array.from({ length: BROWSER_SITE_NOTES_PAGE }, (_, index) =>
      note({ organizationId, userId }, "member", index),
    ),
    ...Array.from({ length: size }, (_, index) =>
      note({ organizationId, userId: otherUserId }, "colleague", index),
    ),
  ];
  await database.insert(chatBrowserSiteNotes).values(rows);
  const noteIds = rows.map(({ id }) => id);
  return {
    cleanup: async () => {
      await database
        .delete(chatBrowserSiteNotes)
        .where(inArray(chatBrowserSiteNotes.id, noteIds));
    },
    database: withQueryLogger(database, queryCountLogger),
    organizationId,
    userId,
  };
};

type BrowserSiteNotesFixture = Awaited<
  ReturnType<typeof seedBrowserSiteNotesScaling>
>;

export const browserSiteNotesScalingScenario = {
  name: "chat browser site notes",
  definition: listBrowserSiteNotes,
  measure: async (fixture: BrowserSiteNotesFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await listBrowserSiteNotes.handler(
        asTestRaw<Parameters<typeof listBrowserSiteNotes.handler>[0]>({
          query: {},
          request: new Request(
            "https://example.test/v1/chat/browser-site-notes",
          ),
          route: "/v1/chat/browser-site-notes",
          safeDb: createSafeDb(
            fixture.database,
            [],
            fixture.organizationId,
            fixture.userId,
          ),
          session: { activeOrganizationId: fixture.organizationId },
          user: { id: fixture.userId },
          memberRole: sessionMemberRole("member"),
        }),
      );
      if (response instanceof HttpStatusResponse || !("sites" in response)) {
        return panic(
          "Browser site note scaling requires a successful response",
        );
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.sites.flatMap(({ notes }) => notes).length,
      };
    }),
};
