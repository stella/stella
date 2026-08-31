/**
 * The same proposal as `POST /positions`, reported as it is written.
 *
 * A reference checklist is tens of terms and takes minutes to produce. Asking
 * for it in one response means the reviewer waits with nothing on screen and
 * then meets the whole list at once. This endpoint sends each side, each
 * verified position, and each skipped term the moment the model closes it, so
 * the confirm step fills in while the model is still working.
 *
 * Same body, same prompt, same normalizer: a position that arrives here is
 * byte-identical to the one the batch endpoint would have returned for the
 * same model output.
 */

import { Result } from "better-result";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { prepareReferenceProposal } from "@/api/handlers/document-reviews/prepare-proposal";
import { streamReferenceProposal } from "@/api/handlers/document-reviews/reference-positions";
import { proposeReviewPositionsBodySchema } from "@/api/handlers/document-reviews/schemas";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { pinProposedPositions } from "@/api/lib/document-review/reference-passages";

const config = {
  description:
    "Stream proposed review positions from one or more reference documents as they are produced: the target's parties first, then each verified position (its kind, severity, what the term is for and what to compare, and the reference passages that state the standard), then what was read and deliberately not compared.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "realtime_stream" },
  body: proposeReviewPositionsBodySchema,
} satisfies HandlerConfig;

/**
 * Why a stream stopped short. Everything a caller can be refused for — a
 * matter they cannot open, a model the organization has not enabled, an
 * exhausted budget — is decided before the response starts and answered with
 * an ordinary status code; only a failure once bytes are flowing arrives as an
 * event.
 */
export const REVIEW_PROPOSAL_STREAM_ERROR = {
  /** The model call failed, was cut short, or ran past its ceiling. Whatever
   *  already streamed stays valid; the list is simply not complete. */
  FAILED: "proposal_failed",
} as const;

const proposePositionsStream = createSafeHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    request,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const organizationId = session.activeOrganizationId;
    const prepared = yield* yield* prepareReferenceProposal({
      body,
      orgAIConfig,
      orgAIConfigStatus,
      organizationId,
      safeDb,
      userId: user.id,
      workspaceId,
    });

    const serviceTier = "standard" as const;
    const events = streamReferenceProposal({
      target: prepared.target,
      references: prepared.references,
      seededPositions: body.seededPositions,
      perspective: body.perspective,
      positionsMax: DOCUMENT_REVIEW_LIMITS.positionsMax,
      targetEntityVersionId: prepared.targetEntityVersionId,
      organizationId,
      workspaceId,
      orgAIConfig,
      promptCachingEnabled,
      serviceTier,
      usageMetering: {
        actionType: "chat",
        organizationId,
        safeDb,
        serviceTier,
        userId: user.id,
        workspaceId,
      },
      // The client hanging up cancels the model call: nobody is left to read
      // the rest of the checklist, and the tokens are still being paid for.
      abortSignal: request.signal,
    });

    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const writeEvent = (event: string, data: unknown): void => {
          if (request.signal.aborted) {
            return;
          }
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        };
        try {
          for await (const event of events) {
            if (request.signal.aborted) {
              break;
            }
            switch (event.type) {
              case "parties":
                writeEvent("parties", { parties: event.parties });
                break;
              case "position": {
                // The words leave through their own rows, never through the
                // wire: the position is pinned before its frame is written
                // and the frame carries ids. One write per position, in
                // stream order, because each is answered as it is decided.
                // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- SAFETY: one write per streamed position, bounded by the proposal cap; the frame must carry row ids, so it cannot be written before its pin lands
                const pinned = await safeDb(
                  async (tx) =>
                    await pinProposedPositions(tx, {
                      organizationId,
                      positions: [event.position],
                    }),
                );
                if (Result.isError(pinned)) {
                  throw pinned.error;
                }
                writeEvent("position", {
                  index: event.index,
                  position: pinned.value[0],
                });
                break;
              }
              case "skipped":
                writeEvent("skipped", {
                  index: event.index,
                  skipped: event.skipped,
                });
                break;
              case "done":
                writeEvent("done", {
                  positionCount: event.positionCount,
                  skippedCount: event.skippedCount,
                });
                break;
              default:
                event satisfies never;
            }
          }
        } catch {
          // `streamReferenceProposal` already reported the cause to analytics;
          // the wire carries a code, never a provider message.
          writeEvent("error", { code: REVIEW_PROPOSAL_STREAM_ERROR.FAILED });
        } finally {
          if (!request.signal.aborted) {
            controller.close();
          }
        }
      },
    });

    return Result.ok(
      new Response(sse, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      }),
    );
  },
);

export default proposePositionsStream;
