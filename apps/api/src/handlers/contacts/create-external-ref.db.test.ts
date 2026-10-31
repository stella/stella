import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import { contacts } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { HttpStatusResponse } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createContact from "./create";
import type { CreateContactBody } from "./create";

/**
 * An external ref is unique only within one organization. Creating a contact
 * through the REST route with a ref another organization holds must create
 * the caller's own contact, and a refusal must only ever name the caller's
 * own contact.
 */

let db: TestDatabase;

type Tenant = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const createTenant = async (name: string): Promise<Tenant> => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await db.insert(organization).values({
    id: organizationId,
    name,
    slug: `contact-create-ref-${organizationId}`,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name,
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  return { organizationId, userId };
};

const createVia = async (tenant: Tenant, body: CreateContactBody) => {
  const scopedDb = createScopedDb(
    markRlsDatabase(db),
    [],
    tenant.organizationId,
    tenant.userId,
  );
  return await createContact.handler(
    createTestHandlerContext<Parameters<typeof createContact.handler>[0]>({
      scopedDb,
      safeDb: safeDbFromScoped(scopedDb),
      audit: auditRecorderDouble(),
      memberRole: sessionMemberRole("owner"),
      session: { activeOrganizationId: tenant.organizationId },
      user: { id: tenant.userId },
      body,
      params: {},
      query: {},
      route: "/contacts",
      set: { headers: {} },
      request: new Request("https://example.test/contacts", {
        method: "PUT",
        headers: { "Idempotency-Key": mintAuthProviderIdValue() },
      }),
    }),
  );
};

const createdId = (result: unknown): string => {
  if (
    result instanceof Response ||
    result instanceof HttpStatusResponse ||
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    typeof result.id !== "string"
  ) {
    return panic("Contact create did not return a contact");
  }
  return result.id;
};

const tenants: Tenant[] = [];

beforeAll(async () => {
  db = await getTestDb();
});
afterAll(async () => {
  for (const { organizationId, userId } of tenants) {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  }
  await releaseTestDb();
});

describe("contact create by external ref", () => {
  test("a ref another organization holds creates the caller's contact and never names the other organization's", async () => {
    const holder = await createTenant("Ref holder");
    const caller = await createTenant("Ref caller");
    tenants.push(holder, caller);
    const ref = { source: "address-book", id: "SHARED-REST-1" };

    const heldId = createdId(
      await createVia(holder, {
        type: "person",
        displayName: "Holder person",
        external: ref,
      }),
    );

    const ownId = createdId(
      await createVia(caller, {
        type: "person",
        displayName: "Caller person",
        external: ref,
      }),
    );
    expect(ownId).not.toBe(heldId);

    const [stored] = await db
      .select({
        organizationId: contacts.organizationId,
        externalSource: contacts.externalSource,
        externalId: contacts.externalId,
      })
      .from(contacts)
      .where(eq(contacts.id, ownId));
    expect(stored).toEqual({
      organizationId: caller.organizationId,
      externalSource: ref.source,
      externalId: ref.id,
    });

    // A second create of the same ref is refused, naming only the caller's
    // own contact.
    const repeat = await createVia(caller, {
      type: "person",
      displayName: "Caller person again",
      external: ref,
    });
    expect(repeat).toBeInstanceOf(HttpStatusResponse);
    if (!(repeat instanceof HttpStatusResponse)) {
      return panic("A repeated ref was not refused");
    }
    expect(repeat.code).toBe(409);
    const refusal = JSON.stringify(repeat.response);
    expect(refusal).toContain(ownId);
    expect(refusal).not.toContain(heldId);
  });
});
