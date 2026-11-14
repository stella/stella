/**
 * The decision endpoint's contract: a decision names its reviewer and moment,
 * reopening withdraws both, every transition leaves an audit row, and a
 * finding the caller cannot see is indistinguishable from one that is absent.
 */

import { describe, expect, test } from "bun:test";

import type { ApiRoutePath } from "@/api/http/api-route-types";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DOCUMENT_REVIEW_DECISION_REASON_SETTING } from "@/api/lib/document-review/run-contract";
import type { DocumentReviewFindingFlag } from "@/api/lib/document-review/run-contract";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import decideDocumentReviewFinding from "./decide-finding";

type DecideFindingCtx = Parameters<
  typeof decideDocumentReviewFinding.handler
>[0];

const FINDING_ID = toSafeId<"documentReviewFinding">(
  "66666666-6666-4666-8666-666666666666",
);
const RUN_ID = toSafeId<"documentReviewRun">(
  "77777777-7777-4777-8777-777777777777",
);
const WORKSPACE_ID = toSafeId<"workspace">(
  "88888888-8888-4888-8888-888888888888",
);
const USER_ID = toSafeId<"user">("user_01JQ8Z3W6R5K2N4P7T9V1X3Y5A");
const POSITION_ID = "44444444-4444-4444-8444-444444444444";

/** The stored row the endpoint reads before it writes. */
type StoredFinding = {
  runId: SafeId<"documentReviewRun">;
  positionId: string;
  payload: {
    finding: {
      fix: { kind: "replaceBlock"; blockId: string; text: string } | null;
    };
  };
  decision: "open" | "accepted" | "dismissed";
  decidedBy: SafeId<"user"> | null;
  decidedAt: Date | null;
  flags: DocumentReviewFindingFlag[];
  applicationStatus: "pending" | "applied";
  appliedBy: SafeId<"user"> | null;
  appliedAt: Date | null;
};

const storedFinding = (
  decision: StoredFinding["decision"],
): StoredFinding[] => [
  {
    runId: RUN_ID,
    positionId: POSITION_ID,
    payload: {
      finding: {
        fix: { kind: "replaceBlock", blockId: "p-1", text: "Updated" },
      },
    },
    decision,
    decidedBy: decision === "open" ? null : USER_ID,
    decidedAt: decision === "open" ? null : new Date("2026-08-25T08:00:00Z"),
    flags: [],
    applicationStatus: "pending",
    appliedBy: null,
    appliedAt: null,
  },
];

type UpdateValues = {
  decision?: unknown;
  decidedBy?: unknown;
  decidedAt?: unknown;
  flags?: unknown;
  applicationStatus?: unknown;
  appliedBy?: unknown;
  appliedAt?: unknown;
};

const createHarness = (rows: StoredFinding[]) => {
  const updates: UpdateValues[] = [];
  /** Each raw statement, and each update, in the order the handler ran them. */
  const steps: string[] = [];
  const decisionEvents: Record<string, unknown>[] = [];
  const auditEvents: AuditEvent[] = [];
  const { safeDb, scopedDb } = createScopedDbMock({
    // The locked read of the finding, then its decision history.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ for: async () => rows }),
          orderBy: () => ({ limit: async () => [] }),
        }),
      }),
    }),
    update: () => ({
      set: (values: UpdateValues) => {
        updates.push(values);
        steps.push("update");
        return { where: async () => {} };
      },
    }),
    execute: async (statement: { queryChunks?: unknown[] }) => {
      steps.push(
        JSON.stringify(statement.queryChunks ?? statement).includes(
          DOCUMENT_REVIEW_DECISION_REASON_SETTING,
        )
          ? `reason ${JSON.stringify(statement)}`
          : "other",
      );
      return [];
    },
    insert: () => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        decisionEvents.push(...[values].flat());
        return { onConflictDoNothing: async () => {} };
      },
    }),
  });

  const context = asTestRaw<DecideFindingCtx>({
    body: { decision: "accepted" },
    memberRole: sessionMemberRole("owner"),
    params: { workspaceId: WORKSPACE_ID, findingId: FINDING_ID },
    request: new Request(
      `https://example.test/v1/workspaces/${WORKSPACE_ID}/document-reviews/findings/${FINDING_ID}`,
      { method: "PATCH" },
    ),
    route:
      "/v1/workspaces/:workspaceId/document-reviews/findings/:findingId" satisfies ApiRoutePath,
    safeDb,
    scopedDb,
    workspaceId: WORKSPACE_ID,
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test_decisions"),
    },
    user: { id: USER_ID },
    recordAuditEvent: async (
      _tx: unknown,
      event: AuditEvent | AuditEvent[],
    ) => {
      auditEvents.push(...(Array.isArray(event) ? event : [event]));
    },
  });

  return { auditEvents, context, decisionEvents, steps, updates };
};

describe("decideDocumentReviewFinding", () => {
  test("records who decided and when", async () => {
    const { auditEvents, context, decisionEvents, updates } = createHarness(
      storedFinding("open"),
    );

    const result = await decideDocumentReviewFinding.handler({
      ...context,
      body: { decision: "accepted" },
    });

    expect(updates).toHaveLength(1);
    const written = updates.at(0);
    expect(written?.decision).toBe("accepted");
    expect(written?.decidedBy).toBe(USER_ID);
    expect(written?.decidedAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({
      id: FINDING_ID,
      runId: RUN_ID,
      decision: "accepted",
      decidedBy: USER_ID,
    });
    // The history is the database trigger's, written from the decider and
    // moment above; `finding-decisions.postgres.test.ts` covers it.
    expect(decisionEvents).toEqual([]);
    // The answer carries the history as read after the change (the trigger's
    // event is not in this mock), folded by the shared fold.
    expect(result).toMatchObject({
      decisions: {
        events: [],
        truncated: false,
        current: { decision: null, decidedBy: null },
      },
    });

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents.at(0)).toMatchObject({
      action: AUDIT_ACTION.REVIEW,
      resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN,
      resourceId: RUN_ID,
      changes: { decision: { old: "open", new: "accepted" } },
      metadata: { findingId: FINDING_ID, positionId: POSITION_ID },
    });
  });

  // The history trigger reads the reason from a transaction-local setting:
  // set for the decision's own update and cleared after it, so no other
  // write in the transaction carries it.
  test("a reason travels with the decision it was given for, and only it", async () => {
    const { context, steps } = createHarness(storedFinding("open"));
    await decideDocumentReviewFinding.handler({
      ...context,
      body: { decision: "dismissed", reason: "Covered by clause 9." },
    });
    expect(steps.map((step) => step.split(" ")[0])).toEqual([
      "reason",
      "update",
      "reason",
    ]);
    expect(steps.at(0)).toContain("Covered by clause 9.");

    // Restating the decision is no new decision: its reason is not recorded.
    const restated = createHarness(storedFinding("dismissed"));
    await decideDocumentReviewFinding.handler({
      ...restated.context,
      body: { decision: "dismissed", flags: ["needs-review"], reason: "Again" },
    });
    expect(restated.steps).toEqual(["update"]);
  });

  // Reopening must withdraw the decider with the decision: the column pair is
  // constrained to agree, so writing one without the other is a failed write.
  test("clears the decider and the moment when reopened", async () => {
    const { auditEvents, context, decisionEvents, updates } = createHarness(
      storedFinding("dismissed"),
    );

    const result = await decideDocumentReviewFinding.handler({
      ...context,
      body: { decision: "open" },
    });

    expect(updates.at(0)).toEqual({
      decision: "open",
      decidedBy: null,
      decidedAt: null,
    });
    expect(result).toMatchObject({
      decision: "open",
      decidedBy: null,
      decidedAt: null,
    });
    expect(auditEvents.at(0)).toMatchObject({
      changes: { decision: { old: "dismissed", new: "open" } },
    });
    expect(decisionEvents).toEqual([]);
  });

  test("records an applied edit with the accepting decision", async () => {
    const { auditEvents, context, updates } = createHarness(
      storedFinding("open"),
    );

    const result = await decideDocumentReviewFinding.handler({
      ...context,
      body: { decision: "accepted", applicationStatus: "applied" },
    });

    expect(updates.at(0)).toMatchObject({
      decision: "accepted",
      applicationStatus: "applied",
      appliedBy: USER_ID,
    });
    expect(updates.at(0)?.appliedAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({
      decision: "accepted",
      applicationStatus: "applied",
      appliedBy: USER_ID,
    });
    expect(auditEvents.at(0)).toMatchObject({
      changes: {
        decision: { old: "open", new: "accepted" },
        applicationStatus: { old: "pending", new: "applied" },
      },
    });
  });

  test("replaying an applied decision preserves its original actors and moments", async () => {
    const rows = storedFinding("accepted");
    const finding = rows.at(0);
    if (finding !== undefined) {
      finding.applicationStatus = "applied";
      finding.appliedBy = USER_ID;
      finding.appliedAt = new Date("2026-08-25T08:01:00Z");
    }
    const { auditEvents, context, updates } = createHarness(rows);

    const result = await decideDocumentReviewFinding.handler({
      ...context,
      body: { decision: "accepted", applicationStatus: "applied" },
    });

    expect(result).toMatchObject({
      decision: "accepted",
      decidedAt: "2026-08-25T08:00:00.000Z",
      applicationStatus: "applied",
      appliedAt: "2026-08-25T08:01:00.000Z",
    });
    expect(updates).toEqual([]);
    expect(auditEvents).toEqual([]);
  });

  test("rejects an application mark when the finding has no proposed edit", async () => {
    const rows = storedFinding("accepted");
    const finding = rows.at(0);
    if (finding !== undefined) {
      finding.payload.finding.fix = null;
    }
    const { auditEvents, context, updates } = createHarness(rows);

    const result = await decideDocumentReviewFinding.handler({
      ...context,
      body: { decision: "accepted", applicationStatus: "applied" },
    });

    expect(result).toMatchObject({
      code: 422,
      response: {
        message: "This review finding has no proposed edit to apply.",
      },
    });
    expect(updates).toEqual([]);
    expect(auditEvents).toEqual([]);
  });

  // Flagging is not deciding. The card sends the decision it already holds so
  // the endpoint's required field is satisfied; that must not re-stamp when
  // the decision was taken or who took it.
  test("setting flags leaves the decision's decider and moment alone", async () => {
    const { auditEvents, context, updates } = createHarness(
      storedFinding("accepted"),
    );

    const result = await decideDocumentReviewFinding.handler({
      ...context,
      body: { decision: "accepted", flags: ["follow-up", "important"] },
    });

    expect(updates.at(0)).toEqual({
      decision: "accepted",
      decidedBy: USER_ID,
      decidedAt: new Date("2026-08-25T08:00:00Z"),
      // Stored as a set: deduplicated and in one order, whatever order the
      // reviewer clicked them in.
      flags: ["follow-up", "important"],
    });
    expect(result).toMatchObject({
      decision: "accepted",
      decidedAt: "2026-08-25T08:00:00.000Z",
      flags: ["follow-up", "important"],
    });
    expect(auditEvents.at(0)).toMatchObject({
      changes: { flags: { old: [], new: ["follow-up", "important"] } },
    });
  });

  test("a body without flags changes none", async () => {
    const rows = storedFinding("open");
    const finding = rows.at(0);
    if (finding !== undefined) {
      finding.flags = ["contradiction"];
    }
    const { context, updates } = createHarness(rows);

    const result = await decideDocumentReviewFinding.handler({
      ...context,
      body: { decision: "dismissed" },
    });

    expect(updates.at(0)).toEqual({
      decision: "dismissed",
      decidedBy: USER_ID,
      decidedAt: expect.any(Date),
    });
    expect(result).toMatchObject({ flags: ["contradiction"] });
  });

  // Restating exactly what the row already says is not a reviewer action, so
  // it leaves no audit trail of one.
  test("audits nothing when the request changed nothing", async () => {
    const { auditEvents, context } = createHarness(storedFinding("accepted"));

    await decideDocumentReviewFinding.handler({
      ...context,
      body: { decision: "accepted", flags: [] },
    });

    expect(auditEvents).toEqual([]);
  });

  test("answers 404 for a finding outside the workspace, writing nothing", async () => {
    const { auditEvents, context, updates } = createHarness([]);

    const result = await decideDocumentReviewFinding.handler({
      ...context,
      body: { decision: "dismissed" },
    });

    expect(result).toMatchObject({
      code: 404,
      response: { message: "Review finding not found" },
    });
    expect(updates).toEqual([]);
    expect(auditEvents).toEqual([]);
  });
});
