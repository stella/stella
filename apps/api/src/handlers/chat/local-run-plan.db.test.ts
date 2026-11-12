import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import "@/api/tests/setup-env";

import {
  CHAT_LOCAL_RUN_REFUSAL,
  type ChatLocalRunTarget,
} from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_FEATURE_ID,
  type DesktopRunnerApprovalMode,
} from "@stll/api-contract/desktop-runner";

import type { SafeDb } from "@/api/db/safe-db";
import { organizationSettings } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { resolveChatLocalRun } from "@/api/handlers/chat/local-run-plan";
import { toSafeId } from "@/api/lib/branded-types";
import {
  readLocalRunApprovalCeiling,
  updateLocalRunApprovalCeiling,
} from "@/api/lib/chat/local-run-approval-ceiling";
import type {
  DesktopRunnerControl,
  PickedDesktop,
} from "@/api/lib/desktop-runner/control";
import { createLocalRunBell } from "@/api/lib/desktop-runner/doorbell";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const MODEL = "sonnet";

let testDb: TestDatabase;
let ids: TestIds;

// timeout: booting the full PGlite schema can exceed the default hook budget.
beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
}, 60_000);

afterAll(releaseTestDb);

const safeDb = (): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [], ids.orgA, ids.userA1));

/** An administrator saves the ceiling, as the settings endpoint does. */
const setCeiling = async (maxApprovals: DesktopRunnerApprovalMode) =>
  (
    await safeDb()(
      async (tx) =>
        await updateLocalRunApprovalCeiling(tx, {
          organizationId: ids.orgA,
          maxApprovals,
          recordAuditEvent: auditRecorderDouble(),
        }),
    )
  ).unwrap();

/** A connected computer whose Claude Code can run in every mode. */
const SANDBOXING: PickedDesktop = {
  type: "available",
  desktopId: Bun.randomUUIDv7(),
  harness: {
    id: "claude-code",
    state: "ready",
    version: "2.1.309",
    capabilities: ["approvals", "interrupt"],
    approvalModes: [...DESKTOP_RUNNER_APPROVAL_MODES],
    models: [{ id: MODEL, label: "Sonnet" }],
  },
  linkedFolders: [],
  approvedFolderIds: [],
};

const snapshot = () =>
  createFeatureAccessSnapshot({
    organizationId: ids.orgA,
    userId: ids.userA1,
    decisions: new Map([
      [
        DESKTOP_RUNNER_FEATURE_ID,
        decideFeatureAccess({
          registry: FEATURE_REGISTRY,
          featureId: DESKTOP_RUNNER_FEATURE_ID,
          organizationId: ids.orgA,
          userId: ids.userA1,
          membership: true,
          user: { email: "member@example.test", emailVerified: true },
          enrolments: [
            {
              featureId: DESKTOP_RUNNER_FEATURE_ID,
              organizationId: ids.orgA,
              userId: ids.userA1,
            },
          ],
          grants: {
            [DESKTOP_RUNNER_FEATURE_ID]: [
              { type: "organization", organizationId: ids.orgA },
            ],
          },
        }),
      ],
    ]),
  });

/** One send of a turn bound for the member's computer. */
const send = async (
  approvals: DesktopRunnerApprovalMode,
  { resumesPausedRun = false }: { resumesPausedRun?: boolean } = {},
) => {
  const runTarget: ChatLocalRunTarget = {
    kind: "local",
    harness: "claude-code",
    model: MODEL,
    approvals,
  };
  const control = asTestRaw<DesktopRunnerControl>({
    pickDesktop: async () => await Promise.resolve(Result.ok(SANDBOXING)),
  });
  const resolved = await resolveChatLocalRun({
    runTarget,
    agentSandboxRequested: false,
    resumesPausedRun,
    featureAccessSnapshot: snapshot(),
    userId: ids.userA1,
    organizationId: ids.orgA,
    chatThreadId: toSafeId<"chatThread">(Bun.randomUUIDv7()),
    workspaceIds: [],
    readApprovalCeiling: async () =>
      await readLocalRunApprovalCeiling(safeDb(), ids.orgA),
    runtime: { control, runBell: createLocalRunBell() },
  });
  if (resolved.isOk()) {
    return resolved.value === undefined ? "cloud" : "routed";
  }
  return HandlerError.is(resolved.error) ? resolved.error.code : "failed";
};

describe("a turn on the member's computer under the organization's ceiling", () => {
  test("every mode runs while the organization never lowered the ceiling", async () => {
    await testDb
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, ids.orgA));
    for (const mode of DESKTOP_RUNNER_APPROVAL_MODES) {
      expect(await send(mode)).toBe("routed");
    }
  });

  test("a mode above the ceiling is refused with its own code, one at or below it runs", async () => {
    await setCeiling("auto");
    expect(await send("full_auto")).toBe(
      CHAT_LOCAL_RUN_REFUSAL.approvalsAboveLimit,
    );
    expect(await send("auto")).toBe("routed");
    expect(await send("ask")).toBe("routed");
  });

  test("a lowered ceiling holds the next turn, while a paused run keeps the mode it started with", async () => {
    await setCeiling("full_auto");
    expect(await send("full_auto")).toBe("routed");
    await setCeiling("ask");
    expect(await send("full_auto")).toBe(
      CHAT_LOCAL_RUN_REFUSAL.approvalsAboveLimit,
    );
    expect(await send("auto")).toBe(CHAT_LOCAL_RUN_REFUSAL.approvalsAboveLimit);
    expect(await send("full_auto", { resumesPausedRun: true })).toBe("routed");
    // Raised again, the same mode runs on the next turn.
    await setCeiling("full_auto");
    expect(await send("full_auto")).toBe("routed");
  });
});
