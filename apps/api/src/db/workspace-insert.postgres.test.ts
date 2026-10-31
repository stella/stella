import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { defaultMatterVisibilityFor } from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_ACCESS_MODE,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import { createSafeId } from "@/api/lib/branded-types";
import {
  withGatedTestClients,
  withGatedWorkspaceCreation,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgresTests)("workspace insert policy (postgres)", () => {
  for (const mode of ["", ...Object.values(WORKSPACE_ACCESS_MODE), "unknown"]) {
    for (const actor of ["user", "organization"] as const) {
      for (const tenant of ["same", "different"] as const) {
        test(`${actor} actor, ${mode || "unset"} mode, ${tenant} organization`, async () => {
          if (!databaseUrl) {
            panic("DATABASE_URL required");
          }
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const { sql: client } = openClient();
            const organizationId = mintAuthProviderId<"organization">();
            const userId = mintAuthProviderId<"user">();
            const workspaceId = createSafeId<"workspace">();
            const allowed =
              tenant === "same" &&
              (actor === "user" || mode === WORKSPACE_ACCESS_MODE.explicit);

            try {
              await client`INSERT INTO organization (id, name, slug, created_at)
                VALUES (${organizationId}, 'Policy organization', ${organizationId}, now())`;
              await client`INSERT INTO "user" (id, name, email)
                VALUES (${userId}, 'Policy user', ${`${userId}@example.test`})`;
              await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
                VALUES (${mintAuthProviderIdValue()}, ${organizationId}, ${userId}, 'member', now())`;
              const insert = client.begin(async (tx) =>
                withGatedWorkspaceCreation({
                  tx,
                  rows: [
                    {
                      id: workspaceId,
                      organizationId,
                      name: "Policy matter",
                      reference: workspaceId,
                      visibility: defaultMatterVisibilityFor({
                        hasClient: false,
                      }),
                      leadUserId: userId,
                    },
                  ],
                  insert: async (normalizedRows) => {
                    const row =
                      normalizedRows.at(0) ??
                      panic("Missing policy matter creation row");
                    await tx`SELECT
                  set_config('role', 'stella', true),
                  set_config(${SETTING_ORGANIZATION_ID}, ${tenant === "same" ? organizationId : mintAuthProviderId<"organization">()}, true),
                  set_config(${SETTING_USER_ID}, ${actor === "user" ? userId : ""}, true),
                  set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${mode}, true)`;
                    await tx`INSERT INTO workspaces (id, organization_id, name, reference, visibility, lead_user_id)
                  VALUES (${row.id}, ${row.organizationId}, ${row.name}, ${row.reference}, ${row.visibility}, ${row.leadUserId})`;
                    // The statement under test ran with the exact actor/mode above.
                    // Finish its steward fixture as the session owner before the
                    // deferred invariant is checked, without altering those inputs.
                    await tx`SELECT set_config('role', 'none', true)`;
                    await tx`INSERT INTO workspace_members (id, workspace_id, user_id)
                  VALUES (${Bun.randomUUIDv7()}, ${workspaceId}, ${userId})`;
                  },
                }),
              );
              if (allowed) {
                await insert;
              } else {
                expect(await rejectionOf(insert)).toMatchObject({
                  message:
                    'new row violates row-level security policy for table "workspaces"',
                });
              }
              const rows = await client<{ id: string }[]>`
                SELECT id FROM workspaces WHERE id = ${workspaceId}`;
              expect([...rows]).toEqual(allowed ? [{ id: workspaceId }] : []);
            } finally {
              await client`DELETE FROM organization WHERE id = ${organizationId}`;
              await client`DELETE FROM "user" WHERE id = ${userId}`;
            }
          });
        });
      }
    }
  }
});
