import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { entities, fields } from "@/api/db/schema";
import type { prepareReferenceProposal } from "@/api/handlers/document-reviews/prepare-proposal";
import type {
  openReferenceProposalStream,
  ReviewProposalStreamEvent,
} from "@/api/handlers/document-reviews/reference-positions";
import { toSafeId } from "@/api/lib/branded-types";
import {
  DocumentTooLargeError,
  HandlerError,
  WorkflowIntegrationError,
} from "@/api/lib/errors/tagged-errors";
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
import { createProposePositionsStream } from "./propose-positions-stream";

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

const callHandler = async (
  handler: ReturnType<typeof createProposePositionsStream>,
) =>
  await handler.handler(
    createTestHandlerContext<StreamCtx>({
      audit: NO_AUDIT,
      body,
      session: SESSION,
      ...createScopedDbMock({
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
      }),
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
});
