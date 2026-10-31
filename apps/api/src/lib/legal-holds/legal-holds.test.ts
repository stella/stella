import { Panic, UnhandledException } from "better-result";
import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { LEGAL_HOLD_ACTIVE } from "@stll/api-contract/legal-holds";

import { createSafeId } from "@/api/lib/branded-types";
import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { LegalHoldActiveError } from "./errors";
import { holdTargetPredicate } from "./holds";
import type { HoldTarget } from "./holds";
import { legalHoldRefusal } from "./refusal";

const targets = () =>
  ({
    matter: { type: "matter", workspaceId: createSafeId<"workspace">() },
    entity: { type: "entity", entityId: createSafeId<"entity">() },
    entities: { type: "entities", entityIds: [createSafeId<"entity">()] },
    entityVersion: {
      type: "entityVersion",
      entityVersionId: createSafeId<"entityVersion">(),
    },
    file: { type: "file", fileId: createSafeId<"userFile">() },
    files: { type: "files", objectKeys: ["org/matter/file.pdf"] },
    contacts: { type: "contacts", ids: [createSafeId<"contact">()] },
    thread: { type: "thread", threadId: createSafeId<"chatThread">() },
    account: { type: "account", userId: mintAuthProviderId<"user">() },
    organization: { type: "organization" },
  }) as const satisfies Record<HoldTarget["type"], HoldTarget>;

test("every hold target uses parameterized SQL; empty collections never match", () => {
  const dialect = new PgDialect();
  for (const target of Object.values(targets())) {
    const query = dialect.sqlToQuery(holdTargetPredicate(target));
    if (target.type === "organization") {
      expect(query.sql).toBe("true");
    } else {
      expect(query.params.length).toBeGreaterThan(0);
      for (const value of query.params) {
        if (typeof value === "string") {
          expect(query.sql).not.toContain(value);
        }
      }
    }
  }
  for (const target of [
    { type: "contacts", ids: [] },
    { type: "entities", entityIds: [] },
    { type: "files", objectKeys: [] },
  ] as const) {
    expect(dialect.sqlToQuery(holdTargetPredicate(target)).sql).toBe("false");
  }
});

test("hold refusals retain the shared HTTP MCP and CLI conflict code", () => {
  const holdId = createSafeId<"legalHold">();
  const error = new LegalHoldActiveError({
    message: "An active legal hold prevents deletion.",
    code: LEGAL_HOLD_ACTIVE,
    holds: [
      {
        id: holdId,
        scope: "matter",
        workspaceId: createSafeId<"workspace">(),
        placedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ],
  });
  for (const wrapped of [
    error,
    new UnhandledException({ cause: error }),
    new Panic({ message: "request", cause: error }),
    new HandlerError({
      status: 500,
      message: "Storage deletion failed",
      cause: error,
    }),
  ]) {
    expect(resolveHandlerError(wrapped)).toMatchObject({
      status: 409,
      code: LEGAL_HOLD_ACTIVE,
      cause: error,
      issues: [{ path: holdId, code: "matter" }],
    });
  }
  expect(legalHoldRefusal(error)).toMatchObject({
    status: 409,
    code: LEGAL_HOLD_ACTIVE,
    issues: [{ path: holdId, code: "matter" }],
  });
  expect(
    resolveHandlerError(new HandlerError({ status: 403, message: "Forbidden" }))
      ?.status,
  ).toBe(403);
});
