import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
  SIGNAL_STATUS,
} from "@stll/api-contract/signals";
import type { PermissionInput } from "@stll/permissions";

import { resultTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { SIGNAL_EVENT_TYPE, signals } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { emitSignalRequest } from "@/api/handlers/signals/requests/write";
import { transitionSignal } from "@/api/handlers/signals/transition";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  authorizedMemberRole,
  SESSION_CREDENTIAL,
} from "@/api/lib/permission-authorization";
import { withSignalRequestAuthorization } from "@/api/lib/signals/proofs/may-create-signal-request";
import { withVisibleSignal } from "@/api/lib/signals/proofs/signal-visible-to";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const seeded: SafeId<"signal">[] = [];
const safeDbA1 = () =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));
beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});
afterAll(async () => {
  try {
    if (seeded.length) {
      await testDb.delete(signals).where(inArray(signals.id, seeded));
    }
  } finally {
    await releaseRlsFixture();
  }
});

const requestDraft = () =>
  ({
    kind: SIGNAL_KIND.REQUEST_SUBMITTED,
    scoutKey: SCOUT_KEY.MANUAL_REQUEST,
    severity: SIGNAL_SEVERITY.NOTICE,
    confidence: null,
    title: "Request",
    summary: "Request",
    subject: { type: "none" },
    evidence: {
      kind: SIGNAL_KIND.REQUEST_SUBMITTED,
      description: "Request",
      attachments: [],
    },
    suggestions: [],
    dedupeKey: `proof-request:${createSafeId<"signal">()}`,
  }) as const;

const seed = async (workspaceId: SafeId<"workspace"> | null) => {
  const id = createSafeId<"signal">();
  const draft = requestDraft();
  await testDb.insert(signals).values({
    ...draft,
    suggestions: [],
    id,
    organizationId: ids.orgA,
    workspaceId,
    origin: SIGNAL_KIND_ORIGIN[draft.kind],
    evidence: { ...draft.evidence, attachments: [] },
  });
  seeded.push(id);
  return id;
};

const owner = () =>
  authorizedMemberRole({ role: "owner", credential: SESSION_CREDENTIAL });

describe("signal authorization evidence", () => {
  test.each([
    { scope: "matter", permissions: { signal: ["resolve"] }, expected: 200 },
    { scope: "firm", permissions: { signal: ["resolve"] }, expected: 404 },
    {
      scope: "firm",
      permissions: { signal: ["resolve", "triage"] },
      expected: 200,
    },
    { scope: "matter", permissions: { signal: ["triage"] }, expected: 403 },
  ] satisfies {
    scope: "matter" | "firm";
    permissions: PermissionInput;
    expected: number;
  }[])(
    "transition evidence follows scope and credential $scope $expected",
    async ({ scope, permissions, expected }) => {
      const signalId = await seed(scope === "matter" ? ids.wsA1 : null);
      const outcome = await resultTx(safeDbA1(), (transaction) =>
        withVisibleSignal(
          {
            tx: transaction,
            organizationId: ids.orgA,
            actorUserId: ids.userA1,
            memberRole: authorizedMemberRole({
              role: "owner",
              credential: { type: "attenuated", permissions },
            }),
            signalId,
          },
          async ({ proof }) => Result.ok(proof.kind),
        ),
      );
      if (expected === 200) {
        expect(outcome).toMatchObject({ value: "SignalVisibleTo" });
        return;
      }
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(outcome.error).toMatchObject({ status: expected });
      }
    },
  );

  test.each([
    { scope: "matter", permissions: { signal: ["create"] }, expected: 200 },
    { scope: "firm", permissions: { signal: ["create"] }, expected: 403 },
    {
      scope: "firm",
      permissions: { signal: ["create", "triage"] },
      expected: 200,
    },
    { scope: "matter", permissions: { signal: ["resolve"] }, expected: 403 },
  ] satisfies {
    scope: "matter" | "firm";
    permissions: PermissionInput;
    expected: number;
  }[])(
    "request evidence follows scope and credential $scope $expected",
    async ({ scope, permissions, expected }) => {
      const outcome = await resultTx(safeDbA1(), (transaction) =>
        withSignalRequestAuthorization(
          {
            tx: transaction,
            organizationId: ids.orgA,
            actorUserId: ids.userA1,
            memberRole: authorizedMemberRole({
              role: "owner",
              credential: { type: "attenuated", permissions },
            }),
            workspaceId: scope === "matter" ? ids.wsA1 : null,
          },
          async ({ proof }) => Result.ok(proof.kind),
        ),
      );
      if (expected === 200) {
        expect(outcome).toMatchObject({ value: "MayCreateSignalRequest" });
        return;
      }
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(outcome.error).toMatchObject({ status: expected });
      }
    },
  );

  test("a checked transition records its actor and uses the current row", async () => {
    const signalId = await seed(ids.wsA1);
    const outcome = await resultTx(safeDbA1(), (transaction) =>
      withVisibleSignal(
        {
          tx: transaction,
          organizationId: ids.orgA,
          actorUserId: ids.userA1,
          memberRole: owner(),
          signalId,
        },
        async ({ tx, signal, actor, proof, existing }) => {
          expect(proof.kind).toBe("SignalVisibleTo");
          return await transitionSignal({
            tx,
            signalId: signal,
            actorUserId: actor,
            visibility: proof,
            from: [SIGNAL_STATUS.NEW],
            set: { status: SIGNAL_STATUS.DISMISSED, resolvedAt: new Date() },
            event: { type: SIGNAL_EVENT_TYPE.DISMISSED },
            audit: {
              recordAuditEvent: async () => undefined,
              workspaceId: existing.workspaceId,
              previousStatus: existing.status,
              metadata: {},
            },
          });
        },
      ),
    );
    expect(outcome.isOk()).toBe(true);
    const row = await testDb.query.signals.findFirst({
      where: { id: { eq: signalId } },
    });
    expect(row?.status).toBe(SIGNAL_STATUS.DISMISSED);
    const event = await testDb.query.signalEvents.findFirst({
      where: {
        signalId: { eq: signalId },
        type: { eq: SIGNAL_EVENT_TYPE.DISMISSED },
      },
    });
    expect(event?.actorUserId).toBe(ids.userA1);
  });

  test("a prepared action requires the same persisted version", async () => {
    const signalId = await seed(ids.wsA1);
    const prepared = await testDb.query.signals.findFirst({
      where: { id: { eq: signalId } },
    });
    if (!prepared) {
      throw new Error("Expected signal fixture");
    }
    await testDb
      .update(signals)
      .set({ updatedAt: new Date(prepared.updatedAt.getTime() + 1000) })
      .where(eq(signals.id, signalId));
    const outcome = await resultTx(safeDbA1(), (transaction) =>
      withVisibleSignal(
        {
          tx: transaction,
          organizationId: ids.orgA,
          actorUserId: ids.userA1,
          memberRole: owner(),
          signalId,
          expectedUpdatedAt: prepared.updatedAt,
        },
        async () => Result.ok("prepared"),
      ),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error).toMatchObject({ status: 409 });
    }
  });

  test("request creation obtains scope evidence in its write transaction", async () => {
    const outcome = await resultTx(safeDbA1(), (transaction) =>
      withSignalRequestAuthorization(
        {
          tx: transaction,
          organizationId: ids.orgA,
          actorUserId: ids.userA1,
          memberRole: owner(),
          workspaceId: ids.wsA1,
        },
        async ({ tx, workspace, actor, proof }) => {
          const draft = requestDraft();
          return Result.ok(
            await emitSignalRequest({
              tx,
              workspace,
              actor,
              proof,
              signal: {
                ...draft,
                suggestions: [],
                evidence: { ...draft.evidence, attachments: [] },
              },
            }),
          );
        },
      ),
    );
    expect(outcome.isOk()).toBe(true);
    if (outcome.isErr()) {
      throw outcome.error;
    }
    seeded.push(...outcome.value.insertedIds);
    const id = outcome.value.insertedIds.at(0);
    expect(id).toBeDefined();
    if (!id) {
      throw new Error("Expected inserted request");
    }
    const row = await testDb.query.signals.findFirst({
      where: { id: { eq: id } },
    });
    expect(row).toMatchObject({
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      createdByUserId: ids.userA1,
    });
  });
});
