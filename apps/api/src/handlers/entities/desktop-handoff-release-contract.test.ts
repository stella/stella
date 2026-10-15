import { Result } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import Elysia from "elysia";
import * as v from "valibot";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";
import {
  DESKTOP_HANDOFF_FAILURE,
  DESKTOP_HANDOFF_PROTOCOL_HEADER,
  DESKTOP_HANDOFF_PROTOCOL_VERSION,
} from "@stll/api-contract/desktop-handoff";
import type { DesktopHandoffFailureReason } from "@stll/api-contract/desktop-handoff";

import type { rootDb, Transaction } from "@/api/db/root";
import { desktopEditHandoffs, pdfSigningSessions } from "@/api/db/schema";
import { createScopedDb, createTenantlessDb } from "@/api/db/scoped";
import { createDesktopEditSessionsRoute } from "@/api/handlers/entities/desktop-edit-sessions-route";
import releaseRequests from "@/api/handlers/entities/desktop-handoff-release-requests.json";
import { createPdfSigningSessionsRoute } from "@/api/handlers/entities/pdf-signing-sessions-route";
import { createSafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import type { DesktopHandoffAuthorizationDependencies } from "@/api/lib/business-registries/desktop/handoff-auth";
import { recordDesktopHandoffFailure } from "@/api/lib/desktop-edit-handoffs";
import { hashDesktopEditHandoffToken } from "@/api/lib/desktop-edit-sessions";
import {
  hashPdfSigningToken,
  recordPdfSigningHandoffFailure,
} from "@/api/lib/files/pdf-signing/sessions";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

setDefaultTimeout(120_000);

const FAILURE_TIME = new Date("2026-10-05T06:00:00.000Z");
const EXPIRES_AT = new Date("2030-10-05T06:00:00.000Z");

let dependencies: DesktopHandoffAuthorizationDependencies;
let rlsFixture: Awaited<ReturnType<typeof getRlsFixture>>;
let tokenDb: TokenScopedDatabase;

beforeAll(async () => {
  rlsFixture = await getRlsFixture();
  const { testDb } = rlsFixture;
  tokenDb = {
    scoped:
      ({ organizationId, userId, workspaceIds }) =>
      async <T>(callback: (tx: Transaction) => Promise<T>) =>
        createScopedDb(
          testDb,
          workspaceIds,
          organizationId,
          userId,
        )(async (tx) => {
          // Transition statements use Bun SQL's array result; PGlite wraps those rows.
          const bunRowsTx = new Proxy(tx, {
            get(target, key, receiver) {
              if (key === "execute") {
                return async (query: SQL) => (await tx.execute(query)).rows;
              }
              return Reflect.get(target, key, receiver);
            },
          });
          return callback(asTestRaw<Transaction>(bunRowsTx));
        }),
    tenantless: asTestRaw<TokenScopedDatabase["tenantless"]>(
      createTenantlessDb(testDb),
    ),
  } satisfies TokenScopedDatabase;
  dependencies = {
    authorizeAccount: authorizeDesktopAccount,
    recordFailure: async ({
      kind,
      handoffToken,
      reason,
      now = FAILURE_TIME,
    }) => {
      switch (kind) {
        case "desktop_edit":
          return await recordDesktopHandoffFailure({
            kind,
            handoffToken,
            reason,
            now,
            db: asTestRaw<Pick<typeof rootDb, "transaction">>(testDb),
          });
        case "pdf_signing":
          return await recordPdfSigningHandoffFailure({
            handoffToken,
            reason,
            db: tokenDb,
            now,
          });
        default: {
          const exhaustive: never = kind;
          return exhaustive;
        }
      }
    },
  };
});

afterAll(async () => {
  await releaseRlsFixture();
});

type SeedPendingHandoffOptions = {
  kind: "desktop_edit" | "pdf_signing";
  handoffToken: string;
};

const seedPendingHandoff = async ({
  kind,
  handoffToken,
}: SeedPendingHandoffOptions) => {
  const { testDb, ids } = rlsFixture;
  if (kind === "desktop_edit") {
    const id = createSafeId<"desktopEditHandoff">();
    await testDb.insert(desktopEditHandoffs).values({
      id,
      workspaceId: ids.wsA1,
      entityId: ids.entityA1,
      propertyId: ids.filePropertyA1,
      createdBy: ids.userA1,
      apiBaseUrl: "https://api.example.test",
      tokenHash: hashDesktopEditHandoffToken(handoffToken),
      expiresAt: EXPIRES_AT,
    });
    return {
      assertFailure: async (reason: DesktopHandoffFailureReason) => {
        const rows = await testDb
          .select({
            failureReason: desktopEditHandoffs.failureReason,
            failedAt: desktopEditHandoffs.failedAt,
          })
          .from(desktopEditHandoffs)
          .where(eq(desktopEditHandoffs.id, id));
        expect(rows).toEqual([
          { failureReason: reason, failedAt: FAILURE_TIME },
        ]);
      },
      cleanup: async () => {
        await testDb
          .delete(desktopEditHandoffs)
          .where(eq(desktopEditHandoffs.id, id));
      },
    };
  }
  const id = createSafeId<"pdfSigningSession">();
  await testDb.insert(pdfSigningSessions).values({
    id,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    propertyId: ids.filePropertyA1,
    createdBy: ids.userA1,
    baseVersionId: ids.entityVersionA1,
    handoffTokenHash: hashPdfSigningToken(handoffToken),
    handoffExpiresAt: EXPIRES_AT,
    tokenExpiresAt: EXPIRES_AT,
  });
  return {
    assertFailure: async (reason: DesktopHandoffFailureReason) => {
      const rows = await testDb
        .select({
          status: pdfSigningSessions.status,
          closeReason: pdfSigningSessions.closeReason,
          closedAt: pdfSigningSessions.closedAt,
        })
        .from(pdfSigningSessions)
        .where(eq(pdfSigningSessions.id, id));
      expect(rows).toEqual([
        { status: "cancelled", closeReason: reason, closedAt: FAILURE_TIME },
      ]);
    },
    cleanup: async () => {
      await testDb
        .delete(pdfSigningSessions)
        .where(eq(pdfSigningSessions.id, id));
    },
  };
};

const createApp = () =>
  new Elysia()
    .use(
      new Elysia({ prefix: STELLA_API_VERSION_PREFIX }).use(
        createDesktopEditSessionsRoute(dependencies),
      ),
    )
    .use(createPdfSigningSessionsRoute(dependencies));

// Captured from git show at the immutable release commits recorded in the
// fixture. Values replace credentials; method, path, headers and JSON keys
// preserve the Rust request builders and camelCase serde serialization.
for (const release of releaseRequests) {
  for (const fixture of release.requests) {
    test(`${release.tag} ${fixture.path} returns an actionable desktop update response`, async () => {
      const seeded = await seedPendingHandoff({
        kind: fixture.path.includes("pdf-signing")
          ? "pdf_signing"
          : "desktop_edit",
        handoffToken: fixture.body.handoffToken,
      });
      try {
        const app = createApp();
        const response = await app.handle(
          new Request(`http://localhost${fixture.path}`, {
            method: fixture.method,
            headers: fixture.headers,
            body: JSON.stringify(fixture.body),
          }),
        );
        expect(response.status).toBe(426);
        const body = await response.json();
        expect(body).toMatchObject({
          code: DESKTOP_HANDOFF_FAILURE.updateRequired,
          message: "Update stella desktop",
        });
        await seeded.assertFailure(DESKTOP_HANDOFF_FAILURE.updateRequired);
      } finally {
        await seeded.cleanup();
      }
    });
  }
}

for (const kind of ["desktop_edit", "pdf_signing"] as const) {
  test(`${kind} with the supported protocol requests the desktop account and records the failure`, async () => {
    const handoffToken = "cd".repeat(32);
    const seeded = await seedPendingHandoff({ kind, handoffToken });
    try {
      const path =
        kind === "desktop_edit"
          ? "/v1/desktop-edit-handoffs/redeem"
          : "/v1/pdf-signing-handoffs/redeem";
      const response = await createApp().handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [DESKTOP_HANDOFF_PROTOCOL_HEADER]: String(
              DESKTOP_HANDOFF_PROTOCOL_VERSION,
            ),
          },
          body: JSON.stringify({ handoffToken }),
        }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: DESKTOP_HANDOFF_FAILURE.accountRequired,
        message: "Reconnect desktop to your account",
      });
      await seeded.assertFailure(DESKTOP_HANDOFF_FAILURE.accountRequired);
    } finally {
      await seeded.cleanup();
    }
  });
}

test("a supported PDF desktop with its matching account redeems the signing session", async () => {
  const handoffToken = "ef".repeat(32);
  const seeded = await seedPendingHandoff({
    kind: "pdf_signing",
    handoffToken,
  });
  const { ids } = rlsFixture;
  const device = await createDesktopDeviceSigner();
  const app = new Elysia().use(
    createPdfSigningSessionsRoute({
      recordFailure: dependencies.recordFailure,
      redemptionDatabase: tokenDb,
      authorizeAccount: async (request) =>
        Result.ok({
          consumedProof: await claimFixtureDeviceProof({
            request: await device.signRequest({
              request,
              credential: "matching-desktop-account",
            }),
            deviceJkt: device.deviceJkt,
            keyId: "desktop-account-key",
            credential: "matching-desktop-account",
          }),
          organizationId: ids.orgA,
          userId: ids.userA1,
          keyId: "desktop-account-key",
          memberRole: sessionMemberRole("member"),
          scopedDb: tokenDb.scoped({
            organizationId: ids.orgA,
            userId: ids.userA1,
            workspaceIds: [ids.wsA1],
          }),
        }),
    }),
  );
  try {
    const response = await app.handle(
      new Request("http://localhost/v1/pdf-signing-handoffs/redeem", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer matching-desktop-account",
          [DESKTOP_HANDOFF_PROTOCOL_HEADER]: String(
            DESKTOP_HANDOFF_PROTOCOL_VERSION,
          ),
        },
        body: JSON.stringify({ handoffToken }),
      }),
    );
    expect(response.status).toBe(200);
    const body = v.parse(
      v.object({
        identity: v.object({ organizationId: v.string(), userId: v.string() }),
        sessionId: v.string(),
        sessionToken: v.string(),
      }),
      await response.json(),
    );
    expect(body.identity).toEqual({
      organizationId: ids.orgA,
      userId: ids.userA1,
    });
    expect(body.sessionId.length).toBeGreaterThan(0);
    expect(body.sessionToken.length).toBeGreaterThan(0);
    const rows = await rlsFixture.testDb
      .select({
        status: pdfSigningSessions.status,
        closedAt: pdfSigningSessions.closedAt,
      })
      .from(pdfSigningSessions)
      .where(
        eq(
          pdfSigningSessions.handoffTokenHash,
          hashPdfSigningToken(handoffToken),
        ),
      );
    expect(rows).toEqual([{ status: "open", closedAt: null }]);
  } finally {
    await seeded.cleanup();
  }
});
