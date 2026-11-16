import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import { entities, fields } from "@/api/db/schema";
import type { prepareReferenceProposal } from "@/api/handlers/document-reviews/prepare-proposal";
import type {
  openReferenceProposalStream,
  ReviewProposalStreamEvent,
} from "@/api/handlers/document-reviews/reference-positions";
import { toSafeId } from "@/api/lib/branded-types";
import {
  DatabaseError,
  DocumentTooLargeError,
  HandlerError,
  WorkflowIntegrationError,
} from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import type {
  ExecutionAdmission,
  startExecutionAdmission,
} from "@/api/lib/rate-limit/execution-admission";
import {
  createTestHandlerContext,
  NO_AUDIT,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import type proposePositionsStream from "./propose-positions-stream";
import {
  createProposePositionsStream,
  REVIEW_PROPOSAL_STREAM_ERROR,
} from "./propose-positions-stream";

type StreamCtx = Parameters<typeof proposePositionsStream.handler>[0];

const WORKSPACE_ID = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000001",
);
const SESSION = {
  id: "session_test",
  activeOrganizationId: toSafeId<"organization">("org_test"),
};

const body = {
  target: {
    entityId: toSafeId<"entity">("00000000-0000-0000-0000-000000000002"),
    fileFieldId: toSafeId<"field">("00000000-0000-0000-0000-000000000004"),
  },
  references: [],
  seededPositions: [],
  perspective: { type: "neutral" },
};

const prepareProposalFake = asTestRaw<typeof prepareReferenceProposal>(
  async function* () {
    return Result.ok({
      target: { kind: "docx" },
      references: [],
      targetEntityVersionId: toSafeId<"entityVersion">("version_target"),
    });
  },
);

type AdmissionFakeOptions = {
  reservation?: Result<void, HandlerError>;
};

const admissionFake = ({
  reservation = Result.ok(),
}: AdmissionFakeOptions = {}) => {
  const calls = { release: 0, reservePeriod: 0 };
  const admission = asTestRaw<ExecutionAdmission>({
    signal: new AbortController().signal,
    modelAdmission: {},
    reservePeriod: async () => {
      calls.reservePeriod += 1;
      return await Promise.resolve(reservation);
    },
    release: async () => {
      calls.release += 1;
      await Promise.resolve();
    },
  });
  const startAdmission = asTestRaw<typeof startExecutionAdmission>(
    async () => await Promise.resolve(Result.ok(admission)),
  );
  return { calls, startAdmission };
};

const scopedDbMock = () =>
  createScopedDbMock({
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === entities) {
              return [{ id: body.target.entityId }];
            }
            if (table === fields) {
              return [{ id: body.target.fileFieldId }];
            }
            return [];
          },
        }),
      }),
    }),
  });

const callHandler = async (
  handler: ReturnType<typeof createProposePositionsStream>,
  db: Pick<
    ReturnType<typeof scopedDbMock>,
    "safeDb" | "scopedDb"
  > = scopedDbMock(),
) =>
  await handler.handler(
    createTestHandlerContext<StreamCtx>({
      audit: NO_AUDIT,
      body,
      session: SESSION,
      safeDb: db.safeDb,
      scopedDb: db.scopedDb,
      workspaceId: WORKSPACE_ID,
    }),
  );

const eventsFrom = (
  events: readonly ReviewProposalStreamEvent[],
): AsyncGenerator<ReviewProposalStreamEvent> =>
  (async function* () {
    await Promise.resolve();
    yield* events;
  })();

const DONE_EVENT = {
  type: "done",
  positionCount: 0,
  skippedCount: 0,
} as const satisfies ReviewProposalStreamEvent;

describe("proposePositionsStream", () => {
  test("refuses documents that cannot fit before the response starts", async () => {
    const { calls, startAdmission } = admissionFake();
    const handler = createProposePositionsStream({
      prepareProposal: prepareProposalFake,
      startAdmission,
      openProposalStream: asTestRaw<typeof openReferenceProposalStream>(() =>
        Result.err(
          new WorkflowIntegrationError({
            message: "Too large",
            cause: new DocumentTooLargeError({
              message: "Too large",
              budgetBytes: 100,
            }),
          }),
        ),
      ),
    });

    const result = await callHandler(handler);

    if (!("code" in result)) {
      throw new Error("Expected a refusal status");
    }
    expect(result.code).toBe(413);
    expect(result.response).toMatchObject({ code: "document_too_large" });
    expect(calls).toEqual({ release: 1, reservePeriod: 0 });
  });

  test("reserves the period and streams once the documents fit", async () => {
    const { calls, startAdmission } = admissionFake();
    const handler = createProposePositionsStream({
      prepareProposal: prepareProposalFake,
      startAdmission,
      openProposalStream: asTestRaw<typeof openReferenceProposalStream>(() =>
        Result.ok(eventsFrom([DONE_EVENT])),
      ),
    });

    const result = await callHandler(handler);

    if (!(result instanceof Response)) {
      throw new TypeError("Expected a streaming response");
    }
    expect(await result.text()).toContain("event: done");
    expect(calls).toEqual({ release: 1, reservePeriod: 1 });
  });

  test("releases admission when the period reservation is refused", async () => {
    const refusal = new HandlerError({
      code: "usage_limit_exceeded",
      status: 429,
      message: "Refused",
    });
    const { calls, startAdmission } = admissionFake({
      reservation: Result.err(refusal),
    });
    const handler = createProposePositionsStream({
      prepareProposal: prepareProposalFake,
      startAdmission,
      openProposalStream: asTestRaw<typeof openReferenceProposalStream>(() =>
        Result.ok(eventsFrom([DONE_EVENT])),
      ),
    });

    const result = await callHandler(handler);

    if (!("code" in result)) {
      throw new Error("Expected a refusal status");
    }
    expect(result.code).toBe(429);
    expect(calls).toEqual({ release: 1, reservePeriod: 1 });
  });

  test("reports a failed position pin and ends the stream with a code", async () => {
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const { calls, startAdmission } = admissionFake();
      const pinFailure = new DatabaseError({ message: "Pin failed" });
      const db = scopedDbMock();
      const state = { pinning: false };
      const handler = createProposePositionsStream({
        prepareProposal: prepareProposalFake,
        startAdmission,
        openProposalStream: asTestRaw<typeof openReferenceProposalStream>(() =>
          Result.ok(
            (async function* () {
              await Promise.resolve();
              state.pinning = true;
              yield asTestRaw<ReviewProposalStreamEvent>({
                type: "position",
                index: 0,
                position: {},
              });
            })(),
          ),
        ),
      });

      const result = await callHandler(handler, {
        scopedDb: db.scopedDb,
        safeDb: asTestRaw<typeof db.safeDb>(
          async (run: Parameters<typeof db.safeDb>[0]) =>
            state.pinning ? Result.err(pinFailure) : await db.safeDb(run),
        ),
      });

      if (!(result instanceof Response)) {
        throw new TypeError("Expected a streaming response");
      }
      const frames = await result.text();
      expect(frames).toContain("event: error");
      expect(frames).toContain(REVIEW_PROPOSAL_STREAM_ERROR.FAILED);
      expect(frames).not.toContain("Pin failed");
      expect(logged.mock.calls.map(([event]) => event)).toEqual([
        "document_review.proposal.pin_failed",
      ]);
      expect(calls.release).toBe(1);
    } finally {
      logged.mockRestore();
    }
  });
});
