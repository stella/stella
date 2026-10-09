import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { MODEL_ROLES } from "@stll/ai-catalog";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { USAGE_ACTION_TYPES, USAGE_SERVICE_TIERS } from "@/api/db/schema";
import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  ACCOUNT_ACCESS,
  authorizeHandlerUsage,
  authorizeHandlerRunSize,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { UsageMeteringConfig } from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { ACTION_KINDS } from "@/api/lib/rate-limit/action-kinds";
import type {
  PeriodActionKind,
  ConcurrencyOnlyActionKind,
} from "@/api/lib/rate-limit/action-kinds";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { canonicalModuleId } from "../../../../../.oxlint-plugins/module-id.ts";
import { OWNERSHIP } from "../../../../../scripts/ownership";
import { discoverConditionalOperations } from "../../../scripts/lib/enumerate-checked-operations";
import {
  discoverSafeHandlers,
  REPO_ROOT,
} from "../../../scripts/lib/enumerate-safe-handlers";

const testState = createTestState({ file: import.meta.path, config: env });

const meteringSchema = v.object({
  actionType: v.picklist(USAGE_ACTION_TYPES),
  modelRole: v.exactOptional(v.picklist(MODEL_ROLES)),
  serviceTier: v.exactOptional(v.picklist(USAGE_SERVICE_TIERS)),
  laneRouting: v.exactOptional(v.literal(true)),
} satisfies Record<keyof UsageMeteringConfig, v.GenericSchema>);

const discovery = await discoverSafeHandlers();
const checkedEndpoints = discovery.endpoints.filter(
  ({ config }) => config["requiresUsage"] !== undefined,
);
const organizationId = toSafeId<"organization">("evidence_org");
const userId = toSafeId<"user">("evidence_user");
const ownConfig: OrgAIConfig = {
  providers: [{ provider: "openai", apiKey: "fixture-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-4.1" },
    fast: { provider: "openai", modelId: "gpt-4.1-mini" },
    pdf: { provider: "openai", modelId: "gpt-5.6" },
    reasoning: { provider: "openai", modelId: "o3" },
  },
  decision: null,
};
const safeDb: SafeDb = async <T>() =>
  Result.err<T, SafeDbError>(
    new DatabaseError({ message: "Unexpected evidence fixture database read" }),
  );

// Exercise each discovered declaration through the actual factory boundary.
describe.serial("registered handler admission", () => {
  test("discovers every configured endpoint without import failures", () => {
    expect(discovery.importErrors).toEqual([]);
    expect(checkedEndpoints.length).toBeGreaterThan(0);
  });
  for (const endpoint of checkedEndpoints) {
    for (const allowed of [true, false]) {
      test(`${endpoint.id}: ${allowed ? "allows checked execution" : "refuses execution"}`, async () => {
        testState.setConfig("USAGE_ENFORCEMENT_ENABLED", true);
        let executions = 0;
        const metering = v.parse(
          meteringSchema,
          endpoint.config["requiresUsage"],
        );
        const checked = createSafeRootHandler(
          {
            permissions: { chat: ["create"] },
            accountAccess: ACCOUNT_ACCESS.sandbox,
            mcp: { type: "internal", reason: "assistant_chat" },
            requiresUsage: metering,
          },
          async function* () {
            executions += 1;
            return Result.ok({ completed: true });
          },
        );
        const result = await checked.handler(
          asTestRaw({
            request: new Request("https://example.test/checked"),
            route: "/checked",
            session: { activeOrganizationId: organizationId },
            user: { id: userId },
            memberRole: sessionMemberRole("owner"),
            orgAIConfig: ownConfig,
            orgAIConfigStatus: allowed
              ? ORG_AI_CONFIG_STATUS.ok
              : ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
            managedAIResidency: "eu",
            safeDb,
            scopedDb: async () => {
              throw new DatabaseError({
                message: "Unexpected scoped fixture database read",
              });
            },
            getActiveWorkspaceIds: async () => [],
            getAccessibleWorkspaces: async () => [],
            getWorkspaceAccess: async () => null,
            recordAuditEvent: async () => undefined,
            createAuditRecorder: () => async () => undefined,
          }),
        );
        expect(executions).toBe(allowed ? 1 : 0);
        if (allowed) {
          expect(result).toEqual({ completed: true });
        } else {
          expect(result).toMatchObject({ code: 403 });
        }
      });
    }
  }
});

const actionKinds = Object.keys(ACTION_KINDS).filter(
  (kind): kind is keyof typeof ACTION_KINDS =>
    Object.hasOwn(ACTION_KINDS, kind),
);
const periodKinds = actionKinds.filter(
  (kind): kind is PeriodActionKind => ACTION_KINDS[kind].admission === "period",
);
const backgroundKinds = actionKinds.filter(
  (kind): kind is ConcurrencyOnlyActionKind =>
    ACTION_KINDS[kind].admission === "concurrency-only",
);

for (const kind of actionKinds) {
  for (const allowed of [true, false]) {
    test(`registered action ${kind}: ${allowed ? "allows checked execution" : "refuses execution"}`, async () => {
      let executions = 0;
      const common = {
        enabled: true,
        serviceBudgetsEnabled: false,
        organizationId,
        userId,
        scope: "independent" as const,
        policy: {
          organizationConcurrency: 2,
          userConcurrency: 2,
          leaseMs: 120_000,
        },
        redis: { send: async () => await Promise.resolve(allowed ? 1 : -1) },
        run: async () => {
          executions += 1;
          return await Promise.resolve("completed");
        },
      };
      const background = backgroundKinds.find(
        (candidate) => candidate === kind,
      );
      const period = periodKinds.find((candidate) => candidate === kind);
      const result =
        background !== undefined
          ? await withActionAdmission({
              ...common,
              execution: "background-job",
              mode: "concurrency-only",
              actionKind: background,
            })
          : await withActionAdmission({
              ...common,
              periodIdentity: {
                actionKind:
                  period ??
                  panic("Registered action has no admission classification"),
                logicalPhaseId: "fixture-phase",
              },
              periodPolicy: { periodMs: 3_600_000, limit: 2 },
            });
      expect(executions).toBe(allowed ? 1 : 0);
      expect(result.status).toBe(allowed ? "ok" : "error");
    });
  }
}

const conditionalOperations = await discoverConditionalOperations();

describe.serial("registered conditional admission", () => {
  test("discovers exactly the registered runtime conditional operation owners", async () => {
    const entry = OWNERSHIP.find(
      ({ id }) => id === "conditional-operation-predicates",
    );
    if (
      entry?.enforcement.kind !== "import" ||
      entry.enforcement.names === undefined
    ) {
      panic("Conditional operation owners must have import enforcement");
    }
    const { names: checkerNames, specifiers } = entry.enforcement;
    const names = new Set(checkerNames);
    const expectedOwners: string[] = [];
    for (const file of entry.owner) {
      const text = await Bun.file(path.join(REPO_ROOT, file)).text();
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
      const hasRuntimeChecker = source.statements.some((statement) => {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
        ) {
          return false;
        }
        const moduleId = canonicalModuleId(
          statement.moduleSpecifier.text,
          file,
        );
        if (
          !specifiers.some(
            (specifier) => canonicalModuleId(specifier, file) === moduleId,
          )
        ) {
          return false;
        }
        const bindings = statement.importClause?.namedBindings;
        if (bindings === undefined) {
          return false;
        }
        if (ts.isNamespaceImport(bindings)) {
          return true;
        }
        return bindings.elements.some(
          (binding) =>
            !binding.isTypeOnly &&
            names.has(binding.propertyName?.text ?? binding.name.text),
        );
      });
      if (hasRuntimeChecker) {
        expectedOwners.push(file);
      }
    }
    expect(conditionalOperations.map(({ file }) => file).toSorted()).toEqual(
      expectedOwners.toSorted(),
    );
  });
  for (const operation of conditionalOperations) {
    for (const allowed of [true, false]) {
      test(`${operation.file}:${operation.line}: ${allowed ? "exposes checked execution" : "withholds execution"}`, async () => {
        testState.setConfig("USAGE_ENFORCEMENT_ENABLED", true);
        testState.setConfig("AI_PROVIDER", "openrouter");
        testState.setConfig("OPENROUTER_API_KEY", "fixture-key");
        let executions = 0;
        const input = {
          metering: v.parse(meteringSchema, operation.metering),
          organizationId,
          userId,
          workspaceId: null,
          orgAIConfig: allowed ? ownConfig : null,
          safeDb,
        };
        const result =
          operation.checker === "authorizeHandlerUsage"
            ? await authorizeHandlerUsage(input)
            : await authorizeHandlerRunSize({
                ...input,
                estimatedUnits: 1,
                confirmedUnits: 1,
              });
        if (result.status === "ok") {
          await result.value.execute(async () => {
            executions += 1;
            await Promise.resolve();
          });
        }
        expect(result.status).toBe(allowed ? "ok" : "error");
        expect(executions).toBe(allowed ? 1 : 0);
        if (result.status === "error") {
          expect(result.error.status).toBe(500);
        }
      });
    }
  }
});
