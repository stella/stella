import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import * as v from "valibot";

import "@/api/tests/setup-env";
import { toSafeId } from "@/api/lib/branded-types";

import { mintContactId } from "./contact-id";
import { createContactBodySchema } from "./create";
import {
  contactIdCollisionCondition,
  importContactRowSchema,
} from "./import-contacts";

const callerId = "00000000-0000-0000-0000-000000000000";

describe("contact server ids", () => {
  test("mints distinct UUIDv7 ids returned for created contacts", () => {
    const createResponseId = mintContactId();
    const importReceiptContactId = mintContactId();

    expect(createResponseId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(importReceiptContactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(importReceiptContactId).not.toBe(createResponseId);
  });

  test("rejects caller-selected ids from create and import bodies", () => {
    expect(
      v.safeParse(createContactBodySchema, {
        id: callerId,
        type: "person",
        displayName: "Ada Lovelace",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(importContactRowSchema, {
        id: callerId,
        type: "person",
        displayName: "Ada Lovelace",
      }).success,
    ).toBe(false);
  });

  test("scopes import collision checks to the caller's organization", () => {
    const organizationId = toSafeId<"organization">("organization-one");
    const candidateId = mintContactId();
    const query = new PgDialect().sqlToQuery(
      contactIdCollisionCondition(organizationId, [candidateId]),
    );

    expect(query.sql).toContain('"contacts"."organization_id" = $1');
    expect(query.sql).toContain('"contacts"."id" in ($2)');
    expect(query.params).toEqual([organizationId, candidateId]);
  });
});
