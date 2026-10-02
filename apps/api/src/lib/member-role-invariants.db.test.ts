import { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { roles } from "@stll/permissions";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: PGlite;

beforeAll(async () => {
  client = await createTestPglite();
}, 120_000);

afterAll(async () => {
  await client.close();
});

const observeFailure = async (operation: Promise<unknown>) =>
  (
    await Result.tryPromise({
      try: () => operation,
      catch: (error) => error,
    })
  ).match({ ok: () => undefined, err: (error) => error });

const fixture = async () => {
  const organizationId = Bun.randomUUIDv7();
  const userId = Bun.randomUUIDv7();
  await client.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Membership', $2)`,
    [userId, `${userId}@membership.test`],
  );
  await client.query(
    `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Membership', $1, now())`,
    [organizationId],
  );
  await client.query(
    `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $1, 'owner', now())`,
    [userId, organizationId],
  );
  return {
    organizationId,
    userId,
    cleanUp: async () => {
      await client.query(`DELETE FROM organization WHERE id = $1`, [
        organizationId,
      ]);
      await client.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    },
  };
};

describe("membership role database invariants", () => {
  test("a live organization retains its last owner on delete and demotion", async () => {
    const data = await fixture();
    try {
      for (const statement of [
        `DELETE FROM member WHERE id = $1`,
        `UPDATE member SET role = 'member' WHERE id = $1`,
      ]) {
        expect(
          await observeFailure(client.query(statement, [data.userId])),
        ).toMatchObject({
          code: "23514",
          constraint: "member_organization_owner_required",
        });
        const { rows } = await client.query<{ role: string }>(
          `SELECT role FROM member WHERE id = $1`,
          [data.userId],
        );
        expect(rows).toEqual([{ role: "owner" }]);
      }
    } finally {
      await data.cleanUp();
    }
  });

  test("organization teardown cascades its last owner but user teardown is refused", async () => {
    const data = await fixture();
    try {
      expect(
        await observeFailure(
          client.query(`DELETE FROM "user" WHERE id = $1`, [data.userId]),
        ),
      ).toMatchObject({
        code: "23514",
        constraint: "member_organization_owner_required",
      });
      await client.query(`DELETE FROM organization WHERE id = $1`, [
        data.organizationId,
      ]);
      const { rows } = await client.query(
        `SELECT id FROM member WHERE id = $1`,
        [data.userId],
      );
      expect(rows).toEqual([]);
    } finally {
      await data.cleanUp();
    }
  });

  test("moving an owner preserves ownership in the source organization", async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      expect(
        await observeFailure(
          client.query(`UPDATE member SET organization_id = $1 WHERE id = $2`, [
            destination.organizationId,
            source.userId,
          ]),
        ),
      ).toMatchObject({
        code: "23514",
        constraint: "member_organization_owner_required",
      });
      await client.query(
        `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'owner', now())`,
        [Bun.randomUUIDv7(), source.organizationId, destination.userId],
      );
      await client.query(
        `UPDATE member SET organization_id = $1 WHERE id = $2`,
        [destination.organizationId, source.userId],
      );
      const { rows } = await client.query<{
        organizationId: string;
        role: string;
      }>(
        `SELECT organization_id AS "organizationId", role FROM member WHERE id = $1`,
        [source.userId],
      );
      expect(rows).toEqual([
        { organizationId: destination.organizationId, role: "owner" },
      ]);
    } finally {
      await source.cleanUp();
      await destination.cleanUp();
    }
  });

  test("owner changes refuse isolation levels that retain a pre-lock snapshot", async () => {
    const data = await fixture();
    try {
      for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"] as const) {
        await client.transaction(async (tx) => {
          await tx.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          const { rows } = await tx.query<{ role: string }>(
            `UPDATE member SET role = 'owner' WHERE id = $1 RETURNING role`,
            [data.userId],
          );
          expect(rows).toEqual([{ role: "owner" }]);
        });
        expect(
          await observeFailure(
            client.transaction(async (tx) => {
              await tx.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
              await tx.query(
                `UPDATE member SET role = 'member' WHERE id = $1`,
                [data.userId],
              );
            }),
          ),
        ).toMatchObject({
          code: "23514",
          constraint: "member_organization_owner_read_committed",
        });
      }
      const { rows } = await client.query<{ role: string }>(
        `SELECT role FROM member WHERE id = $1`,
        [data.userId],
      );
      expect(rows).toEqual([{ role: "owner" }]);
    } finally {
      await data.cleanUp();
    }
  });

  test("validation commits the role constraints before validating both domains", async () => {
    await using database = await PGlite.create();
    await database.exec(`CREATE TABLE organization (id text PRIMARY KEY);
      CREATE TABLE member (organization_id text NOT NULL, role text NOT NULL);
      CREATE TABLE invitation (role text);`);
    const firstMigration = readFileSync(
      nodePath.join(
        import.meta.dir,
        "../../drizzle/20261003123500_membership_role_invariants/migration.sql",
      ),
      "utf-8",
    );
    const validationMigration = readFileSync(
      nodePath.join(
        import.meta.dir,
        "../../drizzle/20261003123600_validate_membership_role_invariants/migration.sql",
      ),
      "utf-8",
    );
    expect(validationMigration).toContain(
      "-- requires: 20261003123500_membership_role_invariants",
    );
    const readConstraints = async () => {
      const { rows } = await database.query<{
        name: string;
        validated: boolean;
      }>(
        `SELECT conname AS name, convalidated AS validated FROM pg_constraint
         WHERE conname IN ('member_single_product_role', 'invitation_single_product_role') ORDER BY conname`,
      );
      return rows;
    };
    const unvalidated = [
      { name: "invitation_single_product_role", validated: false },
      { name: "member_single_product_role", validated: false },
    ];
    await database.exec(`BEGIN; ${firstMigration}`);
    expect(await readConstraints()).toEqual(unvalidated);
    await database.exec(validationMigration);
    expect(await readConstraints()).toEqual(
      unvalidated.map(({ name }) => ({ name, validated: true })),
    );
    await database.exec("ROLLBACK");
    expect(await readConstraints()).toEqual(unvalidated);
  });

  test("the live SQL role domains equal the product role source", async () => {
    const { rows } = await client.query<{
      name: string;
      definition: string;
      validated: boolean;
    }>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition, convalidated AS validated
       FROM pg_constraint WHERE conname IN ('member_single_product_role', 'invitation_single_product_role')`,
    );
    expect(rows.map((row) => row.name).toSorted()).toEqual([
      "invitation_single_product_role",
      "member_single_product_role",
    ]);
    for (const row of rows) {
      const literals = [...row.definition.matchAll(/'([^']+)'/gu)].map(
        (match) => match[1],
      );
      expect(literals.toSorted()).toEqual(Object.keys(roles).toSorted());
      expect(row.validated).toBe(true);
    }
    const migration = readFileSync(
      nodePath.join(
        import.meta.dir,
        "../../drizzle/20261003123500_membership_role_invariants/migration.sql",
      ),
      "utf-8",
    );
    const definitions = [
      ...migration.matchAll(
        /ADD CONSTRAINT "(member_single_product_role|invitation_single_product_role)"\s+CHECK \(([^;]+)\) NOT VALID/gu,
      ),
    ];
    expect(definitions.map((definition) => definition[1]).toSorted()).toEqual([
      "invitation_single_product_role",
      "member_single_product_role",
    ]);
    for (const definition of definitions) {
      const sqlDefinition = definition[2];
      expect(sqlDefinition).toBeDefined();
      const literals = [...(sqlDefinition ?? "").matchAll(/'([^']+)'/gu)].map(
        (match) => match[1],
      );
      expect(literals.toSorted()).toEqual(Object.keys(roles).toSorted());
    }
  });

  test("single product roles persist while combined, unknown and empty roles are refused", async () => {
    const data = await fixture();
    try {
      for (const role of [
        ...Object.keys(roles),
        "admin,member",
        "unknown",
        "",
        " owner",
        null,
      ]) {
        const invitationId = Bun.randomUUIDv7();
        const write = client.query(
          `INSERT INTO invitation (id, organization_id, email, role, expires_at, inviter_id)
           VALUES ($1, $2, $3, $4, now() + interval '1 day', $5)`,
          [
            invitationId,
            data.organizationId,
            `${invitationId}@membership.test`,
            role,
            data.userId,
          ],
        );
        if (role !== null && Object.hasOwn(roles, role)) {
          await write;
          const { rows } = await client.query<{ role: string }>(
            `SELECT role FROM invitation WHERE id = $1`,
            [invitationId],
          );
          expect(rows).toEqual([{ role }]);
        } else {
          expect(await observeFailure(write)).toMatchObject({
            code: "23514",
            constraint: "invitation_single_product_role",
          });
          if (role !== null) {
            expect(
              await observeFailure(
                client.query(`UPDATE member SET role = $1 WHERE id = $2`, [
                  role,
                  data.userId,
                ]),
              ),
            ).toMatchObject({
              code: "23514",
              constraint: "member_single_product_role",
            });
          }
        }
      }
    } finally {
      await data.cleanUp();
    }
  });

  test(
    "membership operation sequences preserve live organization invariants",
    async () => {
      await assertProperty(
        "membership operation sequences preserve live organization invariants",
        fc.asyncProperty(
          fc.array(
            fc.record({
              operation: fc.constantFrom("update", "delete", "insert"),
              target: fc.integer({ min: 0, max: 3 }),
              role: fc.oneof(
                fc.constantFrom(...Object.keys(roles)),
                fc.constantFrom("owner,admin", "unknown", ""),
              ),
            }),
            { minLength: 1, maxLength: 25 },
          ),
          async (operations) => {
            const database = client;
            const data = await fixture();
            const extraUsers = Array.from({ length: 3 }, () =>
              Bun.randomUUIDv7(),
            );
            const users = [data.userId, ...extraUsers];
            const expectedMembers = new Map([[data.userId, "owner"]]);
            try {
              for (const userId of extraUsers) {
                await client.query(
                  `INSERT INTO "user" (id, name, email) VALUES ($1, 'Membership', $2)`,
                  [userId, `${userId}@membership.test`],
                );
              }
              for (const { operation, target, role } of operations) {
                const userId = users.at(target);
                if (!userId) {
                  throw new Error("Membership operation has no target user");
                }
                const previousRole = expectedMembers.get(userId);
                const ownerCount = [...expectedMembers.values()].filter(
                  (value) => value === "owner",
                ).length;
                const invalidRole = !Object.hasOwn(roles, role);
                const invalidWrite =
                  invalidRole &&
                  (operation === "insert" ||
                    (operation === "update" && previousRole !== undefined));
                const removesLastOwner =
                  previousRole === "owner" &&
                  ownerCount === 1 &&
                  (operation === "delete" ||
                    (operation === "update" && role !== "owner"));
                const ownerConstraint = removesLastOwner
                  ? "member_organization_owner_required"
                  : undefined;
                const expectedConstraint = invalidWrite
                  ? "member_single_product_role"
                  : ownerConstraint;
                const outcome = await Result.tryPromise(async () => {
                  switch (operation) {
                    case "insert":
                      await database.query(
                        `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $1, $3, now()) ON CONFLICT (id) DO NOTHING`,
                        [userId, data.organizationId, role],
                      );
                      break;
                    case "update":
                      await database.query(
                        `UPDATE member SET role = $1 WHERE id = $2`,
                        [role, userId],
                      );
                      break;
                    case "delete":
                      await database.query(`DELETE FROM member WHERE id = $1`, [
                        userId,
                      ]);
                      break;
                    default: {
                      const exhaustive: never = operation;
                      return exhaustive;
                    }
                  }
                });
                if (expectedConstraint !== undefined) {
                  expect(outcome.isErr()).toBe(true);
                  if (outcome.isErr()) {
                    expect(outcome.error.cause).toMatchObject({
                      code: "23514",
                      constraint: expectedConstraint,
                    });
                  }
                } else {
                  expect(outcome.isOk()).toBe(true);
                  switch (operation) {
                    case "insert":
                      if (previousRole === undefined) {
                        expectedMembers.set(userId, role);
                      }
                      break;
                    case "update":
                      if (previousRole !== undefined) {
                        expectedMembers.set(userId, role);
                      }
                      break;
                    case "delete":
                      expectedMembers.delete(userId);
                      break;
                    default: {
                      const exhaustive: never = operation;
                      return exhaustive;
                    }
                  }
                }
                const { rows } = await client.query<{
                  id: string;
                  role: string;
                }>(
                  `SELECT id, role FROM member WHERE organization_id = $1 ORDER BY id`,
                  [data.organizationId],
                );
                expect(rows).toEqual(
                  [...expectedMembers]
                    .map(([id, value]) => ({ id, role: value }))
                    .toSorted((a, b) => {
                      if (a.id < b.id) {
                        return -1;
                      }
                      if (a.id > b.id) {
                        return 1;
                      }
                      return 0;
                    }),
                );
                expect(rows.some((row) => row.role === "owner")).toBe(true);
                expect(
                  rows.every((row) => Object.hasOwn(roles, row.role)),
                ).toBe(true);
              }
            } finally {
              await data.cleanUp();
              for (const userId of extraUsers) {
                await client.query(`DELETE FROM "user" WHERE id = $1`, [
                  userId,
                ]);
              }
            }
          },
        ),
        { numRuns: 30 },
      );
    },
    propertyTestTimeout(60_000),
  );
});
