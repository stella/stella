import { panic, Result } from "better-result";
import { inArray } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import { organizationSettings, sharepointConnections } from "@/api/db/schema";
import { encryptSharepointSecret } from "@/api/handlers/sharepoint/crypto";
import listSharepointDriveItems from "@/api/handlers/sharepoint/drives/items/list";
import listSharepointDrives from "@/api/handlers/sharepoint/drives/list";
import listSharepointSites from "@/api/handlers/sharepoint/sites/list";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withTestFetch } from "@/api/tests/helpers/test-fetch";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/** Graph answers the same fixed page whatever stella stores. */
const GRAPH_PAGE_SIZE = 25;
const HOUR_MS = 3_600_000;

const graphPage = Object.assign(
  async () =>
    await Promise.resolve(
      Response.json({
        value: Array.from({ length: GRAPH_PAGE_SIZE }, (_, index) => ({
          id: `01ITEM${String(index).padStart(4, "0")}`,
          name: `Item ${index}.docx`,
          displayName: `Item ${index}`,
          driveType: "documentLibrary",
          size: 1024,
          file: { mimeType: "application/pdf" },
        })),
      }),
    ),
  { preconnect: globalThis.fetch.preconnect },
);

/**
 * `size` organizations, each opted in with one connected member. The measured
 * call reads the first organization's own connection; every other row is
 * stored input that must not grow the read.
 */
export const seedSharepointBrowseScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const members = Array.from({ length: size }, () => ({
    organizationId: mintAuthProviderId<"organization">(),
    userId: mintAuthProviderId<"user">(),
  }));
  const target = members.at(0) ?? panic("Browse scaling needs a member");
  const encrypted = await encryptSharepointSecret({
    purpose: "sharepoint_access_token",
    secret: "scaling-access-token",
    organizationId: target.organizationId,
    userId: target.userId,
  });
  const expiresAt = new Date(
    Temporal.Now.instant().epochMilliseconds + HOUR_MS,
  );
  const settingIds = members.map(() => createSafeId<"organizationSettings">());
  const connectionIds = members.map(() =>
    createSafeId<"sharepointConnection">(),
  );
  await db.insert(organizationSettings).values(
    members.map(({ organizationId }, index) => ({
      id: settingIds[index] ?? panic("Settings id per member"),
      organizationId,
      sharepointConnectionEnabled: true,
    })),
  );
  await db.insert(sharepointConnections).values(
    members.map(({ organizationId, userId }, index) => ({
      id: connectionIds[index] ?? panic("Connection id per member"),
      organizationId,
      userId,
      accessTokenEncrypted: encrypted.ciphertext,
      accessTokenIv: encrypted.iv,
      expiresAt,
      status: "connected" as const,
    })),
  );
  const safeDb: SafeDb = async (work) =>
    await Result.tryPromise(async () => await db.transaction(work));
  return {
    ...target,
    safeDb,
    cleanup: async () => {
      await db
        .delete(sharepointConnections)
        .where(inArray(sharepointConnections.id, connectionIds));
      await db
        .delete(organizationSettings)
        .where(inArray(organizationSettings.id, settingIds));
    },
  };
};

type SharepointBrowseFixture = Awaited<
  ReturnType<typeof seedSharepointBrowseScaling>
>;

const measureBrowse = async (
  fixture: SharepointBrowseFixture,
  read: (
    context: Record<string, unknown> & {
      request: Request;
      route: string;
    },
  ) => Promise<unknown>,
) =>
  await withTestFetch(
    graphPage,
    async () =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await read({
          session: { activeOrganizationId: fixture.organizationId },
          user: {
            id: fixture.userId,
            email: `${fixture.userId}@example.test`,
            emailVerified: true,
          },
          memberRole: sessionMemberRole("member"),
          safeDb: fixture.safeDb,
          params: { driveId: "b!drive", itemId: "root" },
          query: {},
          request: new Request("https://example.test/v1/sharepoint"),
          route: "/v1/sharepoint",
        });
        if (
          response instanceof HttpStatusResponse ||
          typeof response !== "object" ||
          response === null ||
          !("items" in response) ||
          !Array.isArray(response.items) ||
          response.items.length !== GRAPH_PAGE_SIZE
        ) {
          return panic("A browse read must return Graph's one bounded page");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.items.length,
        };
      }),
  );

export const sharepointBrowseScalingScenarios = [
  {
    name: "sharepoint sites",
    definition: listSharepointSites,
    measure: async (fixture: SharepointBrowseFixture) =>
      await measureBrowse(fixture, async (context) =>
        listSharepointSites.handler(
          asTestRaw<Parameters<typeof listSharepointSites.handler>[0]>(context),
        ),
      ),
  },
  {
    name: "sharepoint drives",
    definition: listSharepointDrives,
    measure: async (fixture: SharepointBrowseFixture) =>
      await measureBrowse(fixture, async (context) =>
        listSharepointDrives.handler(
          asTestRaw<Parameters<typeof listSharepointDrives.handler>[0]>(
            context,
          ),
        ),
      ),
  },
  {
    name: "sharepoint folder items",
    definition: listSharepointDriveItems,
    measure: async (fixture: SharepointBrowseFixture) =>
      await measureBrowse(fixture, async (context) =>
        listSharepointDriveItems.handler(
          asTestRaw<Parameters<typeof listSharepointDriveItems.handler>[0]>(
            context,
          ),
        ),
      ),
  },
];
