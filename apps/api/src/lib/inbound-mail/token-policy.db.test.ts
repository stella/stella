import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { matterInboundAddresses, workspaces } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { generateInboundAddressToken } from "@/api/lib/inbound-mail/address";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
} from "@/api/tests/security/test-utils";

const organizationA = mintAuthProviderId<"organization">();
const organizationB = mintAuthProviderId<"organization">();
const workspaceA1 = createSafeId<"workspace">();
const workspaceA2 = createSafeId<"workspace">();
const workspaceB1 = createSafeId<"workspace">();
const addressA1 = createSafeId<"matterInboundAddress">();
const addressA2 = createSafeId<"matterInboundAddress">();
const addressB1 = createSafeId<"matterInboundAddress">();
const tokenA1 = generateInboundAddressToken();
const tokenA2 = generateInboundAddressToken();
const tokenB1 = generateInboundAddressToken();
const ownerRole = `inbound_token_owner_${Bun.randomUUIDv7().replaceAll("-", "")}`;

let db: TestDatabase;
let originalOwner: string;
let originalForceRls: boolean;

const ownerRows = async (token?: string) =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(ownerRole)}`);
    if (token !== undefined) {
      await tx.execute(
        sql`SELECT set_config('app.inbound_token', ${token}, true)`,
      );
    }
    return await tx
      .select({ id: matterInboundAddresses.id })
      .from(matterInboundAddresses)
      .orderBy(matterInboundAddresses.id);
  });

const errorMessageChain = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

const ownerWrite = async (operation: "insert" | "update" | "delete") =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(ownerRole)}`);
    await tx.execute(
      sql`SELECT set_config('app.inbound_token', ${tokenA1}, true)`,
    );
    switch (operation) {
      case "insert":
        await tx.insert(matterInboundAddresses).values({
          id: createSafeId<"matterInboundAddress">(),
          organizationId: organizationA,
          workspaceId: workspaceA1,
          token: generateInboundAddressToken(),
          revokedAt: new Date(),
        });
        return 1;
      case "update":
        return (
          await tx
            .update(matterInboundAddresses)
            .set({ revokedAt: new Date() })
            .where(eq(matterInboundAddresses.id, addressA1))
            .returning({ id: matterInboundAddresses.id })
        ).length;
      case "delete":
        return (
          await tx
            .delete(matterInboundAddresses)
            .where(eq(matterInboundAddresses.id, addressA1))
            .returning({ id: matterInboundAddresses.id })
        ).length;
    }
  });

beforeAll(async () => {
  db = await getTestDb();
  const ownership = await db.execute<{
    owner: string;
    forceRls: boolean;
  }>(sql`
    SELECT pg_catalog.pg_get_userbyid(relowner) AS owner,
      relforcerowsecurity AS "forceRls"
    FROM pg_catalog.pg_class
    WHERE oid = 'public.matter_inbound_addresses'::regclass
  `);
  const original = ownership.rows.at(0);
  if (!original) {
    throw new Error("Inbound address table is missing");
  }
  originalOwner = original.owner;
  originalForceRls = original.forceRls;

  await db.insert(organization).values([
    {
      id: organizationA,
      name: "Token policy A",
      slug: `token-policy-a-${organizationA}`,
      createdAt: new Date(),
    },
    {
      id: organizationB,
      name: "Token policy B",
      slug: `token-policy-b-${organizationB}`,
      createdAt: new Date(),
    },
  ]);
  await db.insert(workspaces).values([
    {
      id: workspaceA1,
      organizationId: organizationA,
      name: "A1",
      reference: "A1",
    },
    {
      id: workspaceA2,
      organizationId: organizationA,
      name: "A2",
      reference: "A2",
    },
    {
      id: workspaceB1,
      organizationId: organizationB,
      name: "B1",
      reference: "B1",
    },
  ]);
  await db.insert(matterInboundAddresses).values([
    {
      id: addressA1,
      organizationId: organizationA,
      workspaceId: workspaceA1,
      token: tokenA1,
    },
    {
      id: addressA2,
      organizationId: organizationA,
      workspaceId: workspaceA2,
      token: tokenA2,
    },
    {
      id: addressB1,
      organizationId: organizationB,
      workspaceId: workspaceB1,
      token: tokenB1,
    },
  ]);

  await db.execute(
    sql`CREATE ROLE ${sql.identifier(ownerRole)} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
  );
  await db.execute(
    sql`ALTER TABLE public.matter_inbound_addresses OWNER TO ${sql.identifier(ownerRole)}`,
  );
  await db.execute(
    sql`ALTER TABLE public.matter_inbound_addresses FORCE ROW LEVEL SECURITY`,
  );
});

afterAll(async () => {
  try {
    await db.execute(
      sql`ALTER TABLE public.matter_inbound_addresses OWNER TO ${sql.identifier(originalOwner)}`,
    );
    if (!originalForceRls) {
      await db.execute(
        sql`ALTER TABLE public.matter_inbound_addresses NO FORCE ROW LEVEL SECURITY`,
      );
    }
    await db.execute(sql`DROP ROLE ${sql.identifier(ownerRole)}`);
    await db
      .delete(matterInboundAddresses)
      .where(eq(matterInboundAddresses.organizationId, organizationA));
    await db
      .delete(matterInboundAddresses)
      .where(eq(matterInboundAddresses.organizationId, organizationB));
    await db
      .delete(workspaces)
      .where(eq(workspaces.organizationId, organizationA));
    await db
      .delete(workspaces)
      .where(eq(workspaces.organizationId, organizationB));
    await db.delete(organization).where(eq(organization.id, organizationA));
    await db.delete(organization).where(eq(organization.id, organizationB));
  } finally {
    await releaseTestDb();
  }
});

describe("inbound token owner lookup policy", () => {
  test("a non-bypass table owner sees only the exact token row", async () => {
    const attributes = await db.execute<{
      superuser: boolean;
      bypassRls: boolean;
      canLogin: boolean;
    }>(sql`
      SELECT rolsuper AS superuser, rolbypassrls AS "bypassRls",
        rolcanlogin AS "canLogin"
      FROM pg_catalog.pg_roles WHERE rolname = ${ownerRole}
    `);
    expect(attributes.rows.at(0)).toEqual({
      superuser: false,
      bypassRls: false,
      canLogin: false,
    });

    expect(await ownerRows()).toEqual([]);
    expect(await ownerRows("incorrect-token")).toEqual([]);
    expect(await ownerRows(tokenA1)).toEqual([{ id: addressA1 }]);
    expect(await ownerRows(tokenA2)).toEqual([{ id: addressA2 }]);
    expect(await ownerRows(tokenB1)).toEqual([{ id: addressB1 }]);
  });

  test("the token lookup grants no owner write capability", async () => {
    const insertFailure = await ownerWrite("insert").then(
      () => null,
      (error: unknown) => error,
    );
    expect(errorMessageChain(insertFailure)).toMatch(/row-level security/u);
    expect(await ownerWrite("update")).toBe(0);
    expect(await ownerWrite("delete")).toBe(0);
    expect(await ownerRows(tokenA1)).toEqual([{ id: addressA1 }]);
    expect(
      await db
        .select({ revokedAt: matterInboundAddresses.revokedAt })
        .from(matterInboundAddresses)
        .where(eq(matterInboundAddresses.id, addressA1)),
    ).toEqual([{ revokedAt: null }]);
  });

  test("the stella role cannot use the token to read outside its workspace", async () => {
    const scoped = createScopedDb(db, [workspaceA1], organizationA, null);
    for (const token of [tokenA2, tokenB1]) {
      const visible = await scoped(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.inbound_token', ${token}, true)`,
        );
        return await tx
          .select({ id: matterInboundAddresses.id })
          .from(matterInboundAddresses)
          .orderBy(matterInboundAddresses.id);
      });
      expect(visible).toEqual([{ id: addressA1 }]);
    }
  });
});
