import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceFilers,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

import { DEFAULT_ORG_ID } from "./seed-utils";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgresTests)(
  "route smoke correspondence seed (postgres)",
  () => {
    test("the restricted owner seeds correspondence and its filer through tenant RLS", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db, sql: client } = openClient();
        expect(
          await db.execute(sql`
        SELECT r.rolsuper, r.rolbypassrls, d.datdba = r.oid AS owns_database
        FROM pg_roles r JOIN pg_database d ON d.datname = current_database()
        WHERE r.rolname = current_user
      `),
        ).toEqual([
          { rolsuper: false, rolbypassrls: false, owns_database: true },
        ]);
        expect(
          await db.execute(sql`
        SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.oid IN ('public.correspondence'::regclass, 'public.correspondence_filers'::regclass)
          AND c.relforcerowsecurity AND r.rolname = current_user
        ORDER BY c.relname
      `),
        ).toEqual([
          { relname: "correspondence" },
          { relname: "correspondence_filers" },
        ]);

        const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
        const correspondenceId = toSafeId<"correspondence">(Bun.randomUUIDv7());
        const insertedOrganizations = await db
          .insert(organization)
          .values({
            id: DEFAULT_ORG_ID,
            name: "Seed test organization",
            slug: DEFAULT_ORG_ID,
            createdAt: new Date(),
          })
          .onConflictDoNothing()
          .returning({ id: organization.id });
        const insertedUsers = await db
          .insert(user)
          .values({
            id: mintAuthProviderId<"user">(),
            name: "Seed test user",
            email: "test@stella.dev",
            emailVerified: true,
          })
          .onConflictDoNothing()
          .returning({ id: user.id });
        const filer =
          (
            await db
              .select({ id: user.id, name: user.name, email: user.email })
              .from(user)
              .where(eq(user.email, "test@stella.dev"))
              .limit(1)
          ).at(0) ?? panic("Seed test user missing");
        const insertedMembers = await db
          .insert(member)
          .values({
            id: mintAuthProviderIdValue(),
            organizationId: DEFAULT_ORG_ID,
            userId: filer.id,
            role: "member",
            createdAt: new Date(),
          })
          .onConflictDoNothing()
          .returning({ id: member.id });
        const scopedDb = createScopedDb(
          markRlsDatabase(db),
          [workspaceId],
          DEFAULT_ORG_ID,
          toSafeId<"user">(filer.id),
        );
        try {
          await db.insert(workspaces).values({
            id: workspaceId,
            organizationId: DEFAULT_ORG_ID,
            name: `route-smoke-${workspaceId.slice(0, 8)}`,
            reference: workspaceId,
          });
          await db
            .insert(workspaceMembers)
            .values({ workspaceId, userId: filer.id });

          // The native driver preserves the actual server error at the owner boundary.
          const denied = await rejectionOf(client`
          INSERT INTO correspondence (id, organization_id, workspace_id, direction, channel,
            intake, authenticated_sender_address, content_hash, dedup_key, sender,
            recipients_to, recipients_cc, subject, received_at, "references", body_text, spf, dkim, dmarc)
          VALUES (${correspondenceId}, ${DEFAULT_ORG_ID}, ${workspaceId}, 'in', 'email',
            'direct', 'sender@example.test', ${"a".repeat(64)}, ${"b".repeat(64)},
            '{"address":"sender@example.test","name":null}', '[]', '[]', 'Denied owner fixture',
            now(), '[]', 'Fixture body', 'pass', 'pass', 'pass')
        `);
          expect(getPgErrorCode(denied)).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
          expect(denied).toMatchObject({
            message:
              'new row violates row-level security policy for table "correspondence"',
          });

          const child = Bun.spawn({
            cmd: [
              process.execPath,
              "scripts/seed-route-smoke-correspondence.ts",
              workspaceId,
              correspondenceId,
              "Route smoke correspondence",
              DEFAULT_ORG_ID,
              "test@stella.dev",
            ],
            cwd: path.resolve(import.meta.dir, ".."),
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl,
              NODE_ENV: "test",
              STELLA_LOCAL_DEV: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [exitCode, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({
            exitCode: 0,
            stderr: "",
          });
          expect(
            await scopedDb(
              async (tx) =>
                await tx
                  .select({
                    id: correspondence.id,
                    subject: correspondence.subject,
                  })
                  .from(correspondence)
                  .where(eq(correspondence.id, correspondenceId)),
            ),
          ).toEqual([
            { id: correspondenceId, subject: "Route smoke correspondence" },
          ]);
          expect(
            await scopedDb(
              async (tx) =>
                await tx
                  .select({ userId: correspondenceFilers.filedByUserId })
                  .from(correspondenceFilers)
                  .where(
                    eq(correspondenceFilers.correspondenceId, correspondenceId),
                  ),
            ),
          ).toEqual([{ userId: filer.id }]);
        } finally {
          await scopedDb(async (tx) => {
            await tx
              .delete(correspondence)
              .where(
                and(
                  eq(correspondence.id, correspondenceId),
                  eq(correspondence.workspaceId, workspaceId),
                ),
              );
          });
          await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
          for (const row of insertedMembers) {
            await db.delete(member).where(eq(member.id, row.id));
          }
          for (const row of insertedUsers) {
            await db.delete(user).where(eq(user.id, row.id));
          }
          for (const row of insertedOrganizations) {
            await db.delete(organization).where(eq(organization.id, row.id));
          }
        }
      });
    }, 30_000);
  },
);
