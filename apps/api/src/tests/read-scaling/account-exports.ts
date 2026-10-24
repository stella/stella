import { panic } from "better-result";
import { expect } from "bun:test";
import { inArray } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia";

import { user } from "@/api/db/auth-schema";
import { accountExports } from "@/api/db/schema";
import personalDataExportDownloadLink from "@/api/handlers/account-exports/download/get";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type AccountExportScalingMeasurementOptions = {
  size: number;
  handler: typeof personalDataExportDownloadLink.handler;
};

export const accountExportDownloadScalingScenario = {
  name: "account export download link",
  handler: personalDataExportDownloadLink.handler,
  measure: async ({
    size,
    handler,
  }: AccountExportScalingMeasurementOptions) => {
    expect(handler).toBe(personalDataExportDownloadLink.handler);
    // The handler owns its real RLS connection; fixture writes stay outside
    // measurement and are confined to fresh accounts.
    const { rootDb } = await import("@/api/db/root");
    const userId = mintAuthProviderId<"user">();
    const otherUserId = mintAuthProviderId<"user">();
    const userIds = [userId, otherUserId];
    const email = `${userId}@example.test`;
    const exportId = Bun.randomUUIDv7();
    const otherExportId = Bun.randomUUIDv7();
    const expiresAt = new Date("2099-01-01T00:00:00.000Z");
    const privateObjectKey = `private-account-export/${exportId}`;
    const context = (id: string) =>
      asTestRaw<Parameters<typeof personalDataExportDownloadLink.handler>[0]>({
        user: { id: userId, email },
        params: { exportId: id },
        request: new Request(
          `https://example.test/v1/me/data-exports/${id}/download-link`,
        ),
        route: "/v1/me/data-exports/:exportId/download-link",
        set: { headers: {} },
      });
    try {
      await rootDb.insert(user).values(
        userIds.map((id) => ({
          id,
          name: "Account export scaling fixture",
          email: `${id}@example.test`,
        })),
      );
      // Only one export per account may be active; grow the real historical
      // rows around the requested ready export instead of bypassing that index.
      await rootDb.insert(accountExports).values(
        Array.from({ length: size - 1 }, () => ({
          id: Bun.randomUUIDv7(),
          userId,
          status: "expired" as const,
        })),
      );
      await rootDb.insert(accountExports).values([
        {
          id: exportId,
          userId,
          status: "ready",
          objectKey: privateObjectKey,
          expiresAt,
        },
        {
          id: otherExportId,
          userId: otherUserId,
          status: "ready",
          objectKey: `private-account-export/${otherExportId}`,
          expiresAt,
        },
      ]);
      const denied = await handler(context(otherExportId));
      expect(denied).toBeInstanceOf(ElysiaCustomStatusResponse);
      if (!(denied instanceof ElysiaCustomStatusResponse)) {
        panic("Another account's export must not return a download link");
      }
      expect(denied.code).toBe(404);

      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await handler(context(exportId));
        if (response instanceof ElysiaCustomStatusResponse) {
          panic("Ready account export must return its download link");
        }
        const url = new URL(response.download.downloadUrl);
        expect(url.pathname).toBe(`/v1/me/data-exports/${exportId}/download`);
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
        expect(response).toEqual({
          id: exportId,
          download: {
            downloadUrl: url.href,
            expiresAt: expiresAt.toISOString(),
          },
        });
        const serialized = JSON.stringify(response);
        expect(serialized).not.toContain(privateObjectKey);
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(serialized),
          rows: 1,
        };
      });
    } finally {
      await rootDb
        .delete(accountExports)
        .where(inArray(accountExports.userId, userIds));
      await rootDb.delete(user).where(inArray(user.id, userIds));
    }
  },
};
