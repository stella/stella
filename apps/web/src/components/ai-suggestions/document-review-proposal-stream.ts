/**
 * The position proposal, read as it is written.
 *
 * `POST /document-reviews/positions/stream` answers the same proposal as the
 * blocking endpoint, one frame at a time: the target's sides first, then each
 * verified position and each skipped subject the moment the model closes it,
 * then the totals. A reference checklist takes minutes to produce, so the
 * difference is between a reviewer watching a spinner and a reviewer reading
 * the list while it fills.
 *
 * Eden types the blocking call but cannot type a stream, so the frames are
 * parsed here: the event name against a closed union (a rename on the server
 * is one edit in `REVIEW_PROPOSAL_EVENT`), the payload against the shape each
 * one carries.
 */

import * as v from "valibot";

import { parseApiErrorValue } from "@stll/api-contract";

import type {
  ReviewParty,
  ReviewPerspective,
  ReviewSkippedTerm,
} from "@/components/ai-suggestions/document-review-basis.logic";
import { apiUrl } from "@/lib/api-url";
import type { ToAPIErrorProps } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";
import type { Position } from "@/lib/knowledge/playbook-types";
import { readSSEEvents } from "@/lib/sse-events";

/** The frame names the endpoint writes. The parser switches over exactly this
 *  vocabulary, so a name the server renames is one edit here rather than a
 *  branch that silently stops matching. */
export const REVIEW_PROPOSAL_EVENT = {
  PARTIES: "parties",
  POSITION: "position",
  SKIPPED: "skipped",
  DONE: "done",
  ERROR: "error",
} as const;

export type ReviewProposalEventName =
  (typeof REVIEW_PROPOSAL_EVENT)[keyof typeof REVIEW_PROPOSAL_EVENT];

/**
 * One parsed frame.
 *
 * `index` counts per frame kind from 0 and rises by one, so a consumer can
 * place a position in the proposal's own order rather than in arrival order.
 */
export type ReviewProposalStreamEvent =
  | { type: typeof REVIEW_PROPOSAL_EVENT.PARTIES; parties: ReviewParty[] }
  | {
      type: typeof REVIEW_PROPOSAL_EVENT.POSITION;
      index: number;
      position: Position;
    }
  | {
      type: typeof REVIEW_PROPOSAL_EVENT.SKIPPED;
      index: number;
      skipped: ReviewSkippedTerm;
    }
  | {
      type: typeof REVIEW_PROPOSAL_EVENT.DONE;
      positionCount: number;
      skippedCount: number;
    }
  | { type: typeof REVIEW_PROPOSAL_EVENT.ERROR; code: string };

const isProposalEventName = (name: string): name is ReviewProposalEventName =>
  Object.values(REVIEW_PROPOSAL_EVENT).some((known) => known === name);

/**
 * Whether a frame carries a position at all.
 *
 * The identity fields every consumer reads, and nothing else: the payload is
 * this API's own `Position`, already validated by the endpoint that wrote it,
 * and re-stating its whole schema here would be a hand-kept mirror that drifts
 * the first time the server adds a field. What this guards against is a frame
 * that is not a position — a truncated body, a version skew that changed the
 * envelope — not a field-level disagreement Eden would not catch either.
 */
const isProposedPosition = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "sourceId" in value &&
  typeof value.sourceId === "string" &&
  "issue" in value &&
  typeof value.issue === "string" &&
  "enabled" in value &&
  typeof value.enabled === "boolean" &&
  "mode" in value &&
  (value.mode === "graded" || value.mode === "extract");

const partySchema = v.object({
  role: v.string(),
  name: v.nullable(v.string()),
});

/**
 * Why a subject was not compared, as the endpoint states it: a code this app
 * has words for, or the model's own text. Written out per member rather than
 * accepting any `kind`, so a code the server adds without words here fails to
 * parse — and that entry is dropped — instead of rendering as a blank line.
 */
const skipReasonSchema = v.variant("kind", [
  v.object({ kind: v.literal("deal-specific-value") }),
  v.object({ kind: v.literal("structural") }),
  v.object({ kind: v.literal("lower-weight") }),
  v.object({ kind: v.literal("other"), text: v.string() }),
]);

const PAYLOAD_SCHEMA = {
  [REVIEW_PROPOSAL_EVENT.PARTIES]: v.object({ parties: v.array(partySchema) }),
  [REVIEW_PROPOSAL_EVENT.POSITION]: v.object({
    index: v.number(),
    position: v.custom<Position>(isProposedPosition),
  }),
  [REVIEW_PROPOSAL_EVENT.SKIPPED]: v.object({
    index: v.number(),
    skipped: v.object({ subject: v.string(), reason: skipReasonSchema }),
  }),
  [REVIEW_PROPOSAL_EVENT.DONE]: v.object({
    positionCount: v.number(),
    skippedCount: v.number(),
  }),
  [REVIEW_PROPOSAL_EVENT.ERROR]: v.object({ code: v.string() }),
} as const satisfies Record<
  ReviewProposalEventName,
  v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
>;

const parsePayload = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  data: string,
  schema: TSchema,
): v.InferOutput<TSchema> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const result = v.safeParse(schema, parsed);
  return result.success ? result.output : null;
};

/**
 * One frame as an event, or `null` when the name is not part of the
 * vocabulary or the payload does not carry what that name promises. A frame
 * nobody can read is dropped rather than guessed at: the proposal is still
 * whole, it is simply one entry shorter, and `done` says how many there were.
 */
export const parseReviewProposalEvent = (
  name: string,
  data: string,
): ReviewProposalStreamEvent | null => {
  if (!isProposalEventName(name)) {
    return null;
  }
  switch (name) {
    case REVIEW_PROPOSAL_EVENT.PARTIES: {
      const payload = parsePayload(data, PAYLOAD_SCHEMA.parties);
      return payload === null
        ? null
        : { type: REVIEW_PROPOSAL_EVENT.PARTIES, parties: payload.parties };
    }
    case REVIEW_PROPOSAL_EVENT.POSITION: {
      const payload = parsePayload(data, PAYLOAD_SCHEMA.position);
      return payload === null
        ? null
        : {
            type: REVIEW_PROPOSAL_EVENT.POSITION,
            index: payload.index,
            position: payload.position,
          };
    }
    case REVIEW_PROPOSAL_EVENT.SKIPPED: {
      const payload = parsePayload(data, PAYLOAD_SCHEMA.skipped);
      return payload === null
        ? null
        : {
            type: REVIEW_PROPOSAL_EVENT.SKIPPED,
            index: payload.index,
            skipped: payload.skipped,
          };
    }
    case REVIEW_PROPOSAL_EVENT.DONE: {
      const payload = parsePayload(data, PAYLOAD_SCHEMA.done);
      return payload === null
        ? null
        : {
            type: REVIEW_PROPOSAL_EVENT.DONE,
            positionCount: payload.positionCount,
            skippedCount: payload.skippedCount,
          };
    }
    case REVIEW_PROPOSAL_EVENT.ERROR: {
      const payload = parsePayload(data, PAYLOAD_SCHEMA.error);
      return payload === null
        ? null
        : { type: REVIEW_PROPOSAL_EVENT.ERROR, code: payload.code };
    }
    default:
      name satisfies never;
      return null;
  }
};

/**
 * Place a streamed position in the proposal's own order.
 *
 * Frames arrive in order today, but the index is what the server states and
 * arrival order is not; sorting by it means a reordered or replayed frame
 * cannot shuffle the checklist under the reviewer. Seeded positions keep the
 * front of the list: the stream never re-sends them.
 */
export type IndexedPosition = { index: number; position: Position };

export const mergeStreamedPosition = (
  current: readonly IndexedPosition[],
  next: IndexedPosition,
): IndexedPosition[] => {
  const without = current.filter((entry) => entry.index !== next.index);
  return [...without, next].sort((a, b) => a.index - b.index);
};

export type ReviewProposalTarget = { entityId: string; fileFieldId: string };

export type ReviewProposalReference = {
  workspaceId: string;
  entityId: string;
  fileFieldId: string;
};

export type StreamReviewProposalArgs = {
  workspaceId: string;
  target: ReviewProposalTarget;
  references: readonly ReviewProposalReference[];
  seededPositions: readonly Position[];
  perspective: ReviewPerspective;
  signal: AbortSignal;
  /** Answers whether to keep reading; `false` hangs up, which cancels the
   *  model call behind the stream. */
  onEvent: (event: ReviewProposalStreamEvent) => boolean;
};

/**
 * A refused stream. Everything a caller can be refused for — a matter they
 * cannot open, a model the organization has not enabled, an exhausted budget —
 * is decided before the first byte and answered with an ordinary status code,
 * so it reaches the caller here rather than as an `error` frame.
 */
export type StreamReviewProposalResult =
  | { ok: true }
  | { ok: false; error: ToAPIErrorProps | null };

const proposalStreamUrl = (workspaceId: string): `/${string}` =>
  `/workspaces/${workspaceId}/document-reviews/positions/stream`;

/**
 * The client's own ceiling on the whole stream, a little past the server's
 * own (five minutes on the model call): the server is the one that decides
 * when a proposal has run too long, and this only catches a connection that
 * stopped reporting at all.
 */
const PROPOSAL_STREAM_TIMEOUT_MS = 330_000;

export const streamReviewProposal = async ({
  workspaceId,
  target,
  references,
  seededPositions,
  perspective,
  signal,
  onEvent,
}: StreamReviewProposalArgs): Promise<StreamReviewProposalResult> => {
  const response = await fetchWithTimeout(
    apiUrl(proposalStreamUrl(workspaceId)),
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target,
        references,
        seededPositions,
        perspective,
      }),
      signal,
      timeoutMs: PROPOSAL_STREAM_TIMEOUT_MS,
    },
  );

  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    return {
      ok: false,
      error: { status: response.status, value: parseApiErrorValue(value) },
    };
  }
  if (response.body === null) {
    return { ok: false, error: null };
  }

  const outcome = await readSSEEvents(response.body, (frame) => {
    const event = parseReviewProposalEvent(frame.event, frame.data);
    if (event === null) {
      return true;
    }
    const keepReading = onEvent(event);
    // `done` is the endpoint's last frame, so the read stops on it: a body
    // that drains without one ended early (a proxy cut it, the server died),
    // and the positions received so far are not the whole proposal.
    return keepReading && event.type !== REVIEW_PROPOSAL_EVENT.DONE;
  });
  if (outcome === "drained") {
    return { ok: false, error: null };
  }
  return { ok: true };
};
