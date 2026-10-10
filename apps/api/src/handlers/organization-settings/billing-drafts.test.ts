import { Value } from "@sinclair/typebox/value";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";

import {
  billingDraftUserSettings,
  billingGuidelineFiles,
} from "@/api/db/schema";
import { requireSkillManager } from "@/api/handlers/skills/managed-skill";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";

import {
  readBillingDraftConfiguration,
  updateBillingDraftConfiguration,
} from "./billing-drafts";

const dialect = new PgDialect();

describe("billing draft configuration authorization", () => {
  test("only administrators manage the gate, attachments, and knowledge content", () => {
    const userId = toSafeId<"user">("billing-draft-test-user");
    for (const role of [
      "owner",
      "admin",
      "member",
      "intern",
      "external",
    ] as const) {
      const allowed = role === "owner" || role === "admin";
      const memberRole = sessionMemberRole(role);
      for (const handler of [
        readBillingDraftConfiguration,
        updateBillingDraftConfiguration,
      ]) {
        expect(
          hasMemberPermission(memberRole, handler.config.permissions),
        ).toBe(allowed);
      }
      expect(
        requireSkillManager({
          skill: { scope: "team", userId },
          userId,
          memberRole,
          action: "edit",
        }).isOk(),
      ).toBe(allowed);
    }
  });

  test("every attachment mutation checks the organization and current admin membership in SQL", () => {
    const policies = getTableConfig(billingGuidelineFiles).policies;
    for (const action of ["insert", "update", "delete"] as const) {
      const policy = policies.find((candidate) => candidate.for === action);
      expect(policy).toBeDefined();
      const expression =
        action === "insert" ? policy?.withCheck : policy?.using;
      expect(expression).toBeDefined();
      if (!expression) {
        panic("Mutation policy requires an expression");
      }
      const sql = dialect.sqlToQuery(expression).sql;
      expect(sql).toContain("app.organization_id");
      expect(sql).toContain("app.user_id");
      expect(sql).toContain("m.role IN ('owner', 'admin')");
    }
    for (const policy of getTableConfig(billingDraftUserSettings).policies) {
      const expression = policy.using ?? policy.withCheck;
      if (!expression) {
        panic("Personal settings policy requires an expression");
      }
      expect(dialect.sqlToQuery(expression).sql).toContain("app.user_id");
    }
  });

  test("refuses unknown configuration fields, unsupported modes, duplicate files, and excessive client attachments", () => {
    const resourceId = createSafeId<"agentSkillResource">();
    for (const body of [
      { mode: "other" },
      { mode: "enabled", content: "unowned markdown" },
      { resourceIds: [resourceId, resourceId] },
      {
        resourceIds: Array.from({ length: 11 }, () =>
          createSafeId<"agentSkillResource">(),
        ),
      },
      { timeBillingFormat: "other" },
    ]) {
      expect(
        Value.Check(updateBillingDraftConfiguration.config.body, body),
      ).toBe(false);
    }
    expect(
      Value.Check(updateBillingDraftConfiguration.config.body, {
        mode: "enabled",
        resourceIds: [resourceId],
      }),
    ).toBe(true);
  });
});
