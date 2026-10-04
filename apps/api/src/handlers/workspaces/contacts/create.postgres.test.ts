import { Result, panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { member, organization, user } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import type { SafeDb } from "@/api/db/safe-db";
import {
  contacts,
  workspaceContacts,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { isPgConstraintError } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

import { readWorkspaceContactsHandler } from "../workspace-contacts-read";
import { createWorkspaceContactHandler } from "./create";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const BLOCK_OBSERVATION_DEADLINE_MS = 5000;

if (!databaseUrl || !runPostgresTests) {
  describe.skip("matter contact capacity concurrency (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(true);
    });
  });
} else {
  describe("matter contact capacity concurrency (postgres)", () => {
    test("capacity recount requires READ COMMITTED isolation", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const writer = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const workspaceId = createSafeId<"workspace">();
        const contactId = createSafeId<"contact">();
        try {
          await setup.db.insert(organization).values({
            id: organizationId,
            name: "Isolation fixture",
            slug: organizationId,
            createdAt: new Date(),
          });
          await setup.db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Isolation fixture",
            reference: "CONTACT-ISOLATION",
          });
          await setup.db.insert(contacts).values({
            id: contactId,
            organizationId,
            type: "person",
            displayName: "Isolation fixture",
          });
          const outcome = await Result.tryPromise(
            async () =>
              await writer.sql.begin(async (tx) => {
                await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
                await tx`INSERT INTO workspace_contacts (id, organization_id, workspace_id, contact_id, role) VALUES (${createSafeId<"workspaceContact">()}, ${organizationId}, ${workspaceId}, ${contactId}, 'other')`;
              }),
          );
          expect(outcome.isErr()).toBe(true);
          if (outcome.isOk()) {
            panic("Capacity recount must refuse a fixed transaction snapshot");
          }
          expect(
            isPgConstraintError(
              outcome.error,
              "0A000",
              "workspace_contacts_capacity_isolation",
            ),
          ).toBe(true);
          expect(
            await setup.db.$count(
              workspaceContacts,
              eq(workspaceContacts.workspaceId, workspaceId),
            ),
          ).toBe(0);
        } finally {
          await setup.db
            .delete(organization)
            .where(eq(organization.id, organizationId));
        }
      });
    });
    test.each([
      { firstRole: "witness", firstWriter: "handler", secondWriter: "handler" },
      {
        firstRole: "expert_witness",
        firstWriter: "handler",
        secondWriter: "handler",
      },
      { firstRole: "witness", firstWriter: "raw", secondWriter: "raw" },
      { firstRole: "expert_witness", firstWriter: "raw", secondWriter: "raw" },
      { firstRole: "witness", firstWriter: "raw", secondWriter: "handler" },
      {
        firstRole: "expert_witness",
        firstWriter: "handler",
        secondWriter: "raw",
      },
    ] as const)(
      "serializes the final contact place for $firstWriter then $secondWriter ($firstRole)",
      async ({ firstRole, firstWriter, secondWriter }) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const setup = openClient();
          const first = openClient();
          const second = openClient();
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const workspaceId = createSafeId<"workspace">();
          const contactIds = Array.from(
            { length: LIMITS.workspaceContactsCount + 1 },
            () => createSafeId<"contact">(),
          );
          const witnessContactId = contactIds.at(-2);
          const expertContactId = contactIds.at(-1);
          if (!witnessContactId || !expertContactId) {
            panic("Contact capacity fixture needs two candidates");
          }
          const firstContactId =
            firstRole === "witness" ? witnessContactId : expertContactId;
          const secondContactId =
            firstRole === "witness" ? expertContactId : witnessContactId;
          const releaseFirst = Promise.withResolvers<undefined>();
          const firstCallbackDone = Promise.withResolvers<undefined>();
          let firstAddition:
            | ReturnType<typeof addContact>
            | ReturnType<typeof insertRawContact>
            | undefined;
          let secondAddition:
            | ReturnType<typeof addContact>
            | ReturnType<typeof insertRawContact>
            | undefined;
          const secondQueries: string[] = [];
          const attemptedContactInsert = () =>
            secondQueries.some(
              (query) =>
                /^insert\b/iu.test(query.trimStart()) &&
                query.includes('"workspace_contacts"'),
            );
          const secondDatabase = drizzle({
            client: second.sql,
            relations: databaseRelations,
            logger: {
              logQuery: (query) => {
                secondQueries.push(query);
              },
            },
          });
          const firstSafeDb = createSafeDb(
            markRlsDatabase(first.db),
            [workspaceId],
            organizationId,
            userId,
          );
          const heldSafeDb: SafeDb = async (transactionWork) =>
            await firstSafeDb(async (tx) => {
              const result = await transactionWork(tx);
              firstCallbackDone.resolve(undefined);
              await releaseFirst.promise;
              return result;
            });
          const secondSafeDb = createSafeDb(
            markRlsDatabase(secondDatabase),
            [workspaceId],
            organizationId,
            userId,
          );

          try {
            await setup.db.insert(organization).values({
              id: organizationId,
              name: "Contact capacity fixture",
              slug: organizationId,
              createdAt: new Date(),
            });
            await setup.db.insert(user).values({
              id: userId,
              name: "Contact capacity fixture",
              email: `${userId}@example.test`,
            });
            await setup.db.insert(member).values({
              id: mintAuthProviderIdValue(),
              organizationId,
              userId,
              role: "owner",
              createdAt: new Date(),
            });
            await setup.db.insert(workspaces).values({
              id: workspaceId,
              organizationId,
              name: "Contact capacity fixture",
              reference: "CONTACT-1",
            });
            await setup.db.insert(workspaceMembers).values({
              workspaceId,
              userId,
            });
            await setup.db.insert(contacts).values(
              contactIds.map((id, index) => ({
                id,
                organizationId,
                type: "person" as const,
                displayName: `Fixture contact ${index}`,
              })),
            );
            await setup.db.insert(workspaceContacts).values(
              contactIds
                .slice(0, LIMITS.workspaceContactsCount - 1)
                .map((contactId) => ({
                  organizationId,
                  workspaceId,
                  contactId,
                  role: "other" as const,
                })),
            );
            const firstSession = (
              await first.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
            ).at(0);
            const secondSession = (
              await second.sql<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`
            ).at(0);
            if (!firstSession || !secondSession) {
              panic("Contact capacity fixture sessions need backend pids");
            }

            firstAddition = (
              firstWriter === "raw" ? insertRawContact : addContact
            )({
              safeDb: heldSafeDb,
              organizationId,
              workspaceId,
              body: { contactId: firstContactId, role: firstRole },
            });
            const firstPhase = await Promise.race([
              firstCallbackDone.promise.then(() => ({
                status: "held" as const,
              })),
              firstAddition.then((result) => ({
                status: "settled" as const,
                result,
              })),
            ]);
            if (firstPhase.status === "settled") {
              panic(
                "First contact addition did not reach the commit barrier",
                firstPhase.result,
              );
            }

            const secondState: { status: "pending" | "settled" } = {
              status: "pending",
            };
            secondAddition = (
              secondWriter === "raw" ? insertRawContact : addContact
            )({
              safeDb: secondSafeDb,
              organizationId,
              workspaceId,
              body: {
                contactId: secondContactId,
                role: firstRole === "witness" ? "expert_witness" : "witness",
              },
            }).finally(() => {
              secondState.status = "settled";
            });

            const deadline = performance.now() + BLOCK_OBSERVATION_DEADLINE_MS;
            let blockedByFirst = false;
            while (performance.now() < deadline) {
              if (secondState.status === "settled") {
                break;
              }
              const row = (
                await setup.sql<{ blocked: boolean }[]>`
                  SELECT ${firstSession.pid} = ANY(pg_blocking_pids(${secondSession.pid})) AS blocked
                `
              ).at(0);
              if (row?.blocked) {
                blockedByFirst = true;
                break;
              }
            }
            expect(blockedByFirst).toBe(true);
            // A database trigger would wait after an INSERT was issued. The
            // handler must serialize before attempting that write.
            expect(attemptedContactInsert()).toBe(secondWriter === "raw");

            releaseFirst.resolve(undefined);
            const [firstOutcome, secondOutcome] = await Promise.all([
              firstAddition,
              secondAddition,
            ]);
            expect(firstOutcome.isOk()).toBe(true);
            const replay = await addContact({
              safeDb: secondSafeDb,
              organizationId,
              workspaceId,
              body: { contactId: firstContactId, role: firstRole },
            });
            expect(replay.isErr()).toBe(true);
            if (replay.isOk()) {
              panic("Duplicate link intent must return a conflict");
            }
            expect(replay.error).toMatchObject({
              status: 409,
              message: "Contact already has this role on the matter",
              hint: undefined,
            });
            expect(secondOutcome.isErr()).toBe(true);
            if (secondOutcome.isOk()) {
              panic("Second contact addition must refuse a full matter");
            }
            if (secondWriter === "raw") {
              expect(
                isPgConstraintError(
                  secondOutcome.error,
                  "23514",
                  "workspace_contacts_workspace_capacity",
                ),
              ).toBe(true);
            } else {
              expect(secondOutcome.error).toMatchObject({
                status: 400,
                code: "matter_contact_capacity_reached",
                retryable: false,
              });
            }
            expect(attemptedContactInsert()).toBe(secondWriter === "raw");

            const stored = await setup.db
              .select()
              .from(workspaceContacts)
              .where(eq(workspaceContacts.workspaceId, workspaceId));
            expect(stored).toHaveLength(LIMITS.workspaceContactsCount);
            expect(
              stored.filter((row) => row.contactId === firstContactId),
            ).toHaveLength(1);
            expect(
              stored.filter((row) => row.contactId === secondContactId),
            ).toHaveLength(0);
            const readResult = await readWorkspaceContactsHandler({
              scopedDb: createScopedDb(
                markRlsDatabase(setup.db),
                [workspaceId],
                organizationId,
                userId,
              ),
              workspaceId,
            });
            expect(readResult.isOk()).toBe(true);
            if (readResult.isErr()) {
              panic(
                "Contact read must return all links at capacity",
                readResult.error,
              );
            }
            expect(
              readResult.value.contacts.map((row) => row.id).toSorted(),
            ).toEqual(stored.map((row) => row.id).toSorted());
          } finally {
            releaseFirst.resolve(undefined);
            await Promise.all([firstAddition, secondAddition]);
            await setup.db
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await setup.db.delete(user).where(eq(user.id, userId));
          }
        });
      },
      20_000,
    );
  });
}

type AddContactOptions = Pick<
  Parameters<typeof createWorkspaceContactHandler>[0],
  "safeDb" | "organizationId" | "workspaceId" | "body"
>;

const addContact = async (options: AddContactOptions) =>
  await Result.gen(() =>
    createWorkspaceContactHandler({
      ...options,
      recordAuditEvent: async () => {},
      dependencies: {
        flushWorkspaceSearchRepairs: async () => ({ failed: 0, repaired: 0 }),
      },
    }),
  );

const insertRawContact = async ({
  safeDb,
  organizationId,
  workspaceId,
  body,
}: AddContactOptions) =>
  await safeDb(async (tx) => {
    const [created] = await tx
      .insert(workspaceContacts)
      .values({
        organizationId,
        workspaceId,
        contactId: body.contactId,
        role: body.role,
      })
      .returning();
    if (!created) {
      panic("Raw contact fixture insert did not return a link");
    }
    return created;
  });
