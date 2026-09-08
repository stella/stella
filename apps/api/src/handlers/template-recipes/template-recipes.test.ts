import { describe, expect, test } from "bun:test";
import { ElysiaCustomStatusResponse } from "elysia/error";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db/safe-db";
import { templateRecipeDefinitionSchema } from "@/api/handlers/template-recipes/definition";
import { createTemplateRecipeHandler } from "@/api/handlers/template-recipes/recipes";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";

// ── Helpers ──────────────────────────────────────────────

const fakeOrgId = toSafeId<"organization">("org_test");
const fakeUserId = toSafeId<"user">("user_test");

/** ScopedDb stub that must never be reached: definition validation
 *  rejects before any DB access. */
// SAFETY: test stub; shape satisfies ScopedDb interface for handler mocks
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const throwingScopedDb = (async () => {
  throw new Error("scopedDb must not be called for invalid definitions");
}) as unknown as ScopedDb;

const noopAuditRecorder: AuditRecorder = async () => undefined;

/** The owner's canonical example: a member's position and name, each its own
 *  field, inside a persons loop. */
const personsBlockDefinition = {
  loop: { path: "persons" },
  fields: [
    {
      path: "persons.position",
      label: "Position",
      inputType: "select",
      options: ["rad. praw.", "adw."],
      required: true,
    },
    {
      path: "persons.name",
      label: "Name",
      inputType: "text",
    },
  ],
};

const parse = (definition: unknown) =>
  v.safeParse(templateRecipeDefinitionSchema, definition);

// ── Definition validation ────────────────────────────────

describe("template recipe definition validation", () => {
  test("accepts the persons-block shape", () => {
    const result = parse(personsBlockDefinition);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.loop?.path).toBe("persons");
      expect(result.output.fields).toHaveLength(2);
    }
  });

  test("accepts a plain single-field recipe without a loop", () => {
    const result = parse({
      fields: [{ path: "client_name", inputType: "text" }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects an empty fields array", () => {
    expect(parse({ fields: [] }).success).toBe(false);
  });

  test("rejects a field path that violates the marker grammar", () => {
    const result = parse({
      fields: [{ path: "bad path with spaces" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a field path the marker grammar cannot spell", () => {
    const result = parse({ fields: [{ path: "{{bad}}", inputType: "text" }] });
    expect(result.success).toBe(false);
  });

  test("rejects an invalid loop path", () => {
    const result = parse({
      loop: { path: "persons[]" },
      fields: [{ path: "persons.name" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown keys (strict objects)", () => {
    const result = parse({
      fields: [{ path: "client_name", validationRules: [] }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown input type", () => {
    const result = parse({
      fields: [{ path: "client_name", inputType: "richtext" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown lookup registry", () => {
    const result = parse({
      fields: [{ path: "company", lookup: { registry: "not-a-registry" } }],
    });
    expect(result.success).toBe(false);
  });
});

// ── Create handler boundary ──────────────────────────────

describe("create recipe handler validation", () => {
  test("returns 400 before touching the DB for a bad definition", async () => {
    const result = await createTemplateRecipeHandler({
      scopedDb: throwingScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      body: {
        name: "persons block",
        definition: { fields: [{ path: "bad path" }] },
      },
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toBeInstanceOf(ElysiaCustomStatusResponse);
    if (result instanceof ElysiaCustomStatusResponse) {
      expect(result.code).toBe(400);
      expect(result.response.message).toContain("Invalid recipe definition");
    }
  });

  test("400 message names the failing path", async () => {
    const result = await createTemplateRecipeHandler({
      scopedDb: throwingScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      body: {
        name: "persons block",
        definition: {
          loop: { path: "persons" },
          fields: [{ path: "persons.bad key", inputType: "text" }],
        },
      },
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toBeInstanceOf(ElysiaCustomStatusResponse);
    if (result instanceof ElysiaCustomStatusResponse) {
      expect(result.code).toBe(400);
      expect(result.response.message).toContain("path");
    }
  });
});
