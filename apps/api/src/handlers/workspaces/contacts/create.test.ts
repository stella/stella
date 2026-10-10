import { Result } from "better-result";
import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { createWorkspaceContactHandler } from "./create";

const runFailure = async (failure: DatabaseError) =>
  await Result.gen(() =>
    createWorkspaceContactHandler({
      safeDb: async () => Result.err(failure),
      organizationId: mintAuthProviderId<"organization">(),
      workspaceId: createSafeId<"workspace">(),
      body: { contactId: createSafeId<"contact">(), role: "witness" },
      recordAuditEvent: async () => {},
      dependencies: {
        flushWorkspaceSearchRepairs: async () => ({ failed: 0, repaired: 0 }),
      },
    }),
  );

test("the database contact capacity refusal has the handler's typed corrective action", async () => {
  const result = await runFailure(
    new DatabaseError({
      message: "Database query refused",
      cause: {
        cause: {
          code: "23514",
          constraint: "workspace_contacts_workspace_capacity",
        },
      },
    }),
  );
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    return;
  }
  expect(result.error).toMatchObject({
    status: 400,
    code: "matter_contact_capacity_reached",
    retryable: false,
    hint: expect.stringContaining("matter_contact_id"),
  });
});

test("other check constraints preserve their database error", async () => {
  const failure = new DatabaseError({
    message: "Unrelated database query refused",
    cause: { code: "23514", constraint: "another_constraint" },
  });
  const result = await runFailure(failure);
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    return;
  }
  expect(result.error).toBe(failure);
});

test("duplicate contact roles retain their conflict response", async () => {
  const result = await runFailure(
    new DatabaseError({ code: "23505", message: "Duplicate contact role" }),
  );
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    return;
  }
  expect(result.error).toMatchObject({
    status: 409,
    message: "Contact already has this role on the matter",
  });
});
