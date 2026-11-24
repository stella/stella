import { panic, Result } from "better-result";
import { eq, inArray, sql } from "drizzle-orm";

import { DICTATION_LEARNED_FIX_LIMITS } from "@stll/api-contract/dictation-learned-fixes";
import type { DictationLearnedFixChange } from "@stll/api-contract/dictation-learned-fixes";

import type { SafeDb } from "@/api/db/safe-db";
import { dictationLearnedFixes } from "@/api/db/schema";
import { desktopDeviceProofReplays } from "@/api/db/schema/desktop-device-proof-replay";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  createDesktopLearnedFixesListEndpoint,
  listDesktopLearnedFixes,
} from "@/api/handlers/dictation/learned-fixes/desktop";
import listLearnedFixes from "@/api/handlers/dictation/learned-fixes/list";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import {
  desktopProofRequestUrl,
  VerifiedDesktopDeviceProof,
} from "@/api/lib/business-registries/desktop/proof";
import { ConsumedDesktopDeviceProof } from "@/api/lib/business-registries/desktop/proof-store";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { changeLearnedFixes } from "@/api/lib/dictation/learned-fixes";
import type { LearnedFixOwner } from "@/api/lib/dictation/learned-fixes";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/** Marks the target member's fixes apart from every other row's. */
const OWN = "own";
const PEER = "peer";

/** A full row: as many fixes as a member keeps, each `to` ending in `tag`. */
const fullChanges = (tag: string): DictationLearnedFixChange[] =>
  Array.from({ length: DICTATION_LEARNED_FIX_LIMITS.fixes }, (_, index) => ({
    seq: index + 1,
    type: "taught",
    from: `slovo${String(index)}`,
    to: `Slovo${String(index)}${tag}`,
  }));

/** Whether a read answered the target member's full row and nothing else. */
const isOwnRow = (fixes: readonly { to: string }[]): boolean =>
  fixes.length === DICTATION_LEARNED_FIX_LIMITS.fixes &&
  fixes.every(({ to }) => to.endsWith(OWN));

/**
 * The target member's full row among `size` colleagues' and as many rows
 * of other organizations' members, written through the production store.
 */
export const seedLearnedFixesScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const safeDb: SafeDb = async (work) =>
    await Result.tryPromise(async () => await db.transaction(work));
  const peers: LearnedFixOwner[] = [
    // The same person in another organization.
    { organizationId: otherOrganizationId, userId },
    ...Array.from({ length: size }, () => ({
      organizationId,
      userId: mintAuthProviderId<"user">(),
    })),
    ...Array.from({ length: size }, () => ({
      organizationId: otherOrganizationId,
      userId: mintAuthProviderId<"user">(),
    })),
  ];
  const rows = [
    ...peers.map((owner) => ({ owner, tag: PEER })),
    { owner: { organizationId, userId }, tag: OWN },
  ];
  for (const { owner, tag } of rows) {
    (
      await safeDb(
        async (tx) =>
          await changeLearnedFixes(tx, owner, {
            generation: 0,
            device: Bun.randomUUIDv7(),
            changes: fullChanges(tag),
          }),
      )
    ).unwrap();
  }
  return {
    db,
    organizationId,
    userId,
    safeDb,
    cleanup: async () => {
      await db
        .delete(dictationLearnedFixes)
        .where(
          inArray(dictationLearnedFixes.organizationId, [
            organizationId,
            otherOrganizationId,
          ]),
        );
    },
  };
};

type LearnedFixesFixture = Awaited<ReturnType<typeof seedLearnedFixesScaling>>;

const measured = (response: unknown, rows: number) => ({
  responseBytes: Buffer.byteLength(JSON.stringify(response)),
  rows,
});

export const learnedFixesScalingScenarios = [
  {
    name: "member learned dictation fixes",
    definition: listLearnedFixes,
    measure: async (fixture: LearnedFixesFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listLearnedFixes.handler(
          asTestRaw<Parameters<typeof listLearnedFixes.handler>[0]>({
            session: { activeOrganizationId: fixture.organizationId },
            user: {
              id: fixture.userId,
              email: `${fixture.userId}@example.test`,
              emailVerified: true,
            },
            memberRole: sessionMemberRole("member"),
            safeDb: fixture.safeDb,
            request: new Request(
              "https://example.test/v1/dictation/learned-fixes",
            ),
            route: "/v1/dictation/learned-fixes" satisfies ApiRoutePath,
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          !isOwnRow(response.fixes)
        ) {
          return panic("The read must answer the caller's own fixes only");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          ...measured(response, response.fixes.length),
        };
      }),
  },
  {
    name: "desktop learned dictation fixes",
    definition: listDesktopLearnedFixes,
    measure: async ({ db, organizationId, userId }: LearnedFixesFixture) => {
      const request = new Request(
        "https://api.example.test/v1/desktop/dictation/learned-fixes",
      );
      let receipt: ConsumedDesktopDeviceProof | undefined;
      try {
        await db.execute(sql`GRANT SELECT ON TABLE
          pg_temp."dictation_learned_fixes" TO stella`);
        const signer = await createDesktopDeviceSigner();
        const credential = "scaling-credential";
        const signed = await signer.signRequest({ request, credential });
        const verified = (
          await VerifiedDesktopDeviceProof.verify({
            request: signed,
            expectedUrl: desktopProofRequestUrl(
              signed,
              env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
            ),
            expectedThumbprint: signer.deviceJkt,
            binding: { type: "account", keyId: "scaling-key", credential },
          })
        ).unwrap();
        const consumed = (
          await ConsumedDesktopDeviceProof.claim({ proof: verified, db })
        ).unwrap();
        receipt = consumed;
        // The registry keeps the mounted definition; this production
        // factory is measured with only credential verification supplied.
        const endpoint = createDesktopLearnedFixesListEndpoint({
          authorizeAccount: async () =>
            await Promise.resolve(
              Result.ok({
                organizationId,
                userId,
                keyId: "scaling-key",
                consumedProof: consumed,
                memberRole: sessionMemberRole("member"),
                scopedDb: createMembershipScopedDb(markRlsDatabase(db), {
                  organizationId,
                  userId,
                  serverValidatedWorkspaceIds: [],
                }),
                featureAccessSnapshot: buildFeatureAccessSnapshot({
                  organizationId,
                  userId,
                  identity: {
                    email: `${userId}@example.test`,
                    emailVerified: true,
                  },
                  enrolments: [
                    { featureId: "desktop-dictation", organizationId, userId },
                  ],
                }),
              }),
            ),
        });
        return await runWithMeasuredQueryCounter(async (counter) => {
          const response = await endpoint.handler(
            asTestRaw<Parameters<typeof endpoint.handler>[0]>({
              request,
              route:
                "/v1/desktop/dictation/learned-fixes" satisfies ApiRoutePath,
            }),
          );
          if (
            response instanceof HttpStatusResponse ||
            !isOwnRow(response.fixes)
          ) {
            return panic("The desktop read must answer the member's own fixes");
          }
          return {
            statements: counter.count,
            transactionRoundTrips: counter.transactions,
            ...measured(response, response.fixes.length),
          };
        });
      } finally {
        if (receipt !== undefined) {
          await db
            .delete(desktopDeviceProofReplays)
            .where(eq(desktopDeviceProofReplays.jti, receipt.proof.jti));
        }
      }
    },
  },
];
