/**
 * Pass one: find the claims a document makes.
 *
 * The model reads the document one window of text at a time
 * (`extraction-windows.ts`: sized by text, a long block cut into pieces),
 * with some neighbouring text for context, and lists each claim as a
 * verbatim quote of the block or piece it sits in. The quote is located in
 * that text here, so a claim's anchor is always the document's words, never
 * the model's paraphrase. A quote that cannot be found is shown back once
 * for correction; one that still cannot be found is not a claim this run can
 * point at.
 *
 * A window whose call fails is tried again, twice, after a growing wait,
 * when the failure is one a retry can clear. A window that still fails is
 * reported as text the run did not read, never dropped silently and never
 * failing the windows that were read; only when no window could be read does
 * extraction fail. Losing access or reaching the run's model-call cap ends
 * extraction at once, as before.
 *
 * A run limited to a paragraph range sends only that range's text, so its
 * cost follows the range; a claim's anchor is still an offset into its whole
 * block, where the reader shows it.
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import { mapWithConcurrency } from "@stll/concurrency";
import { backoffDelay } from "@stll/concurrency/backoff-delay";
import { sleep } from "@stll/concurrency/sleep";
import { locateQuote } from "@stll/legal-ast/quote-locate";

import { aiFailureCanClearOnRetry } from "@/api/lib/ai-error";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import {
  CLAIM_FRAMINGS,
  CLAIM_TYPES,
  VERIFICATION_LIMITS,
} from "@/api/lib/lists/verification/contract";
import type {
  ClaimAnchor,
  ClaimFraming,
  ClaimType,
  VerificationUnreadPart,
} from "@/api/lib/lists/verification/contract";
import {
  extractionPieces,
  extractionWindows,
  windowContext,
  windowText,
} from "@/api/lib/lists/verification/extraction-windows";
import type {
  ExtractionPiece,
  ExtractionWindow,
} from "@/api/lib/lists/verification/extraction-windows";
import { createVerificationCall } from "@/api/lib/lists/verification/model-call";
import type {
  ListVerificationAccessRevokedError,
  VerificationModelDeps,
} from "@/api/lib/lists/verification/model-call";
import type { VerificationPassage } from "@/api/lib/lists/verification/paragraph-scope";
import type { ModelRunCapError } from "@/api/lib/usage/model-run-caps/caps";

const CONCURRENCY = 3;
/** Calls after the first a failing window gets. */
export const EXTRACTION_WINDOW_RETRIES = 2;

/** The wait before retry `attempt` (from 0): about 2 s, then about 8 s. */
const retryDelayMs = (attempt: number): number =>
  backoffDelay(attempt, {
    baseMs: 2000,
    factor: 4,
    jitter: { type: "additive", random: Math.random(), rangeMs: 1000 },
  });

const rawClaimSchema = v.strictObject({
  blockId: v.string(),
  quote: v.string(),
  type: v.picklist(CLAIM_TYPES),
  framing: v.picklist(CLAIM_FRAMINGS),
});

/** Read by the structured-output role contract test. @public */
export const extractionSchema = v.strictObject({
  claims: v.array(rawClaimSchema),
});

type RawClaim = v.InferOutput<typeof rawClaimSchema>;

export type ExtractedClaim = {
  type: ClaimType;
  framing: ClaimFraming;
  text: string;
  anchor: ClaimAnchor;
  /** Reading order: the passage's index, then the offset inside it. */
  blockIndex: number;
};

const SYSTEM_PROMPT = `You list the claims a legal document makes, so each can later be checked against a record of evidence.

A claim is one central assertion a reviewer would check as a unit: a thing that happened, a state of affairs, a date, an amount, who did or knew what. Keep that assertion with its own qualifiers, including dates, amounts, parties, negation and limits on the author's knowledge. When later prose in the same passage only restates or characterises that assertion, do not list it as another claim; a supporting detail the record could confirm or contradict on its own (a time, a document, a payment, a witness) is a claim of its own. Keep a distinct opinion or conditional assertion when it is itself a point the author advances. Split a sentence only when it makes distinct points a reviewer would decide independently. Skip identity, background and procedural sentences, as well as headings, definitions, boilerplate and statements of truth.

For each claim give:
- blockId: the id of the block it is in, exactly as supplied.
- quote: the claim's words copied character for character from that block. Quote only the words that make the claim, never text from another block, never a paraphrase.
- type: fact when the record could confirm or refute it; opinion when it is the author's judgment or characterisation; unverifiable when it is factual in form but nothing outside the author's own mind could bear on it.
- framing: recalled when the author presents it as their own recollection or belief ("I recall", "to the best of my knowledge"); otherwise asserted.

List claims in the order they appear. Only list claims in the blocks you are asked about; the blocks around them are context.`;

const windowTask = (
  pieces: readonly ExtractionPiece[],
  window: ExtractionWindow,
): string => {
  const asked = pieces.slice(window.from, window.to);
  const { before, after } = windowContext(pieces, window);
  return `Document blocks:\n${windowText([...before, ...asked, ...after])}\n\nList the claims in these blocks only: ${asked.map((piece) => piece.id).join(", ")}`;
};

type Grounding =
  | { type: "grounded"; claim: ExtractedClaim }
  | { type: "misquoted"; raw: RawClaim; reason: string };

/** What a cited id reads: a piece, or a cut block's whole passage when the
 *  model names the block rather than the piece it was shown. */
type GroundTarget = {
  key: string;
  passageIndex: number;
  start: number;
  end: number;
};

const groundTargets = (
  pieces: readonly ExtractionPiece[],
  passages: readonly VerificationPassage[],
): ReadonlyMap<string, GroundTarget> => {
  const targets = new Map<string, GroundTarget>();
  for (const [passageIndex, { block, start, end }] of passages.entries()) {
    targets.set(block.id, { key: block.id, passageIndex, start, end });
  }
  for (const piece of pieces) {
    targets.set(piece.id, {
      key: piece.id,
      passageIndex: piece.passageIndex,
      start: piece.start,
      end: piece.end,
    });
  }
  return targets;
};

/**
 * The quote's place in the text the model read, as offsets into the whole
 * block: a scoped run's anchors, and a piece's, land where the reader shows
 * the document, not where its slice began.
 */
const ground = (
  raw: RawClaim,
  targets: ReadonlyMap<string, GroundTarget>,
  passages: readonly VerificationPassage[],
  cursor: Map<string, number>,
): Grounding => {
  const target = targets.get(raw.blockId);
  const passage =
    target === undefined ? undefined : passages.at(target.passageIndex);
  if (target === undefined || passage === undefined) {
    return {
      type: "misquoted",
      raw,
      reason: "names a block that does not exist",
    };
  }
  const { block } = passage;
  const read = block.text.slice(target.start, target.end);
  const span = locateQuote(read, raw.quote, cursor.get(target.key) ?? 0);
  if (span === null) {
    return {
      type: "misquoted",
      raw,
      reason: "is not in that block word for word",
    };
  }
  cursor.set(target.key, span.end);
  const text = read
    .slice(span.start, span.end)
    .slice(0, VERIFICATION_LIMITS.CLAIM_TEXT_MAX);
  const start = target.start + span.start;
  const anchor: ClaimAnchor =
    block.source.type === "docx-block"
      ? {
          type: "docx-block",
          blockId: block.source.blockId,
          start,
          end: start + text.length,
        }
      : {
          type: "pdf-page",
          pageNumber: block.source.pageNumber,
          start,
          end: start + text.length,
        };
  return {
    type: "grounded",
    claim: {
      type: raw.type,
      framing: raw.framing,
      text,
      anchor,
      blockIndex: target.passageIndex,
    },
  };
};

const repairMessage = (
  misquoted: readonly { raw: RawClaim; reason: string }[],
) =>
  `These claims could not be found as quoted. For each, give it again with the exact words of the block it is in, or leave it out if it is not in the document:\n${misquoted
    .map(
      ({ raw, reason }) =>
        `- blockId=${raw.blockId} quote=${JSON.stringify(raw.quote)}: ${reason}`,
    )
    .join("\n")}\nAnswer with only these claims.`;

/** Why extraction stops the whole run: no window may go on without it. */
type ExtractionStop = ListVerificationAccessRevokedError | ModelRunCapError;

/** One window's outcome once its retries are spent. */
type WindowOutcome =
  | { type: "read"; claims: ExtractedClaim[] }
  | { type: "unread"; window: ExtractionWindow; cause: unknown }
  // The run was cancelled: every window ends, and the run fails as it
  // would have before reading anything.
  | { type: "cancelled"; cause: unknown };

/** The unread windows as parts of the document, neighbouring windows
 *  joined into one part. */
const unreadParts = (
  pieces: readonly ExtractionPiece[],
  passages: readonly VerificationPassage[],
  windows: readonly ExtractionWindow[],
): VerificationUnreadPart[] => {
  const edge = (pieceIndex: number, side: "start" | "end") => {
    const piece = pieces[pieceIndex];
    const passage =
      piece === undefined ? undefined : passages[piece.passageIndex];
    if (piece === undefined || passage === undefined) {
      return panic("An unread window names a piece outside the run");
    }
    return { blockId: passage.block.id, offset: piece[side] };
  };
  const parts: VerificationUnreadPart[] = [];
  let open: ExtractionWindow | null = null;
  for (const window of windows) {
    if (open !== null && open.to === window.from) {
      open = { from: open.from, to: window.to };
      continue;
    }
    if (open !== null) {
      parts.push({
        start: edge(open.from, "start"),
        end: edge(open.to - 1, "end"),
      });
    }
    open = window;
  }
  if (open !== null) {
    parts.push({
      start: edge(open.from, "start"),
      end: edge(open.to - 1, "end"),
    });
  }
  return parts;
};

export type ClaimExtraction = {
  /** Every grounded claim in reading order, capped at the per-run maximum. */
  claims: ExtractedClaim[];
  /** Text no call could read; empty when the whole run was read. */
  unread: VerificationUnreadPart[];
};

type ExtractClaimsArgs = {
  /** The text the run reads, in reading order: every block whole, or the
   *  slices a paragraph scope keeps. A claim's `blockIndex` indexes this. */
  passages: readonly VerificationPassage[];
  deps: VerificationModelDeps;
  /** The wait before a window's retry; a process-local boundary that
   *  focused tests replace. */
  waitBeforeRetry?: (attempt: number, signal: AbortSignal) => Promise<void>;
};

const waitWithBackoff = async (attempt: number, signal: AbortSignal) => {
  await sleep(retryDelayMs(attempt), { signal });
};

export const extractClaims = async ({
  passages,
  deps,
  waitBeforeRetry = waitWithBackoff,
}: ExtractClaimsArgs): Promise<
  Result<ClaimExtraction, WorkflowIntegrationError>
> => {
  const call = createVerificationCall({
    deps,
    feature: "lists.verification.extract",
    system: SYSTEM_PROMPT,
    shared: null,
    outputSchema: extractionSchema,
  });
  const pieces = extractionPieces(passages);
  const targets = groundTargets(pieces, passages);
  const windows = extractionWindows(pieces);

  /** One call and its repair round. A failed call throws. */
  const readWindow = async (
    window: ExtractionWindow,
  ): Promise<Result<ExtractedClaim[], ExtractionStop>> => {
    const request = call.request(windowTask(pieces, window));
    const output = await call.generate([request]);
    if (Result.isError(output)) {
      return output;
    }
    const cursor = new Map<string, number>();
    const grounded: ExtractedClaim[] = [];
    const misquoted: { raw: RawClaim; reason: string }[] = [];
    for (const raw of output.value.claims) {
      const result = ground(raw, targets, passages, cursor);
      if (result.type === "grounded") {
        grounded.push(result.claim);
      } else {
        misquoted.push(result);
      }
    }
    if (misquoted.length === 0) {
      return Result.ok(grounded);
    }
    const repaired = await call.generate([
      request,
      { role: "assistant", content: JSON.stringify(output.value) },
      { role: "user", content: repairMessage(misquoted) },
    ]);
    if (Result.isError(repaired)) {
      return repaired;
    }
    for (const raw of repaired.value.claims) {
      const result = ground(raw, targets, passages, cursor);
      if (result.type === "grounded") {
        grounded.push(result.claim);
      }
    }
    return Result.ok(grounded);
  };

  /** A window read with its retries. A cancelled run is `cancelled`; a
   *  failure that ends only this window is `unread`. */
  const settleWindow = async (
    window: ExtractionWindow,
    attempt = 0,
  ): Promise<Result<WindowOutcome, ExtractionStop>> => {
    const settled = await Result.tryPromise({
      try: async () => await readWindow(window),
      catch: (cause) => cause,
    });
    if (Result.isOk(settled)) {
      const read = settled.value;
      return Result.isError(read)
        ? Result.err(read.error)
        : Result.ok({ type: "read", claims: read.value });
    }
    const cause = settled.error;
    if (deps.abortSignal.aborted) {
      return Result.ok({ type: "cancelled", cause });
    }
    call.captureError(cause);
    if (
      attempt >= EXTRACTION_WINDOW_RETRIES ||
      !aiFailureCanClearOnRetry(cause)
    ) {
      return Result.ok({ type: "unread", window, cause });
    }
    await waitBeforeRetry(attempt, deps.abortSignal);
    return await settleWindow(window, attempt + 1);
  };

  return Result.flatten(
    await Result.tryPromise({
      try: async () => {
        const perWindow = await mapWithConcurrency({
          items: windows,
          limit: CONCURRENCY,
          operation: async (window) => await settleWindow(window),
        });
        const resolved: ExtractedClaim[] = [];
        const unread: { window: ExtractionWindow; cause: unknown }[] = [];
        for (const outcome of perWindow) {
          if (outcome.isErr()) {
            return Result.err(
              new WorkflowIntegrationError({
                message: "Claim extraction failed",
                cause: outcome.error,
              }),
            );
          }
          switch (outcome.value.type) {
            case "read": {
              resolved.push(...outcome.value.claims);
              break;
            }
            case "unread": {
              unread.push(outcome.value);
              break;
            }
            case "cancelled": {
              return Result.err(
                new WorkflowIntegrationError({
                  message: "Claim extraction failed",
                  cause: outcome.value.cause,
                }),
              );
            }
            default: {
              outcome.value satisfies never;
              return panic("Unhandled extraction window outcome");
            }
          }
        }
        // Nothing read is not a run with no claims: it is a failed one.
        const firstUnread = unread.at(0);
        if (firstUnread !== undefined && unread.length === windows.length) {
          return Result.err(
            new WorkflowIntegrationError({
              message: "Claim extraction failed",
              cause: firstUnread.cause,
            }),
          );
        }
        // A claim listed twice (in two windows, or again in a repair) is one
        // claim: its anchor is its identity.
        const unique = new Map<string, ExtractedClaim>();
        for (const claim of resolved) {
          const key = `${String(claim.blockIndex)}:${String(claim.anchor.start)}:${String(claim.anchor.end)}`;
          if (!unique.has(key)) {
            unique.set(key, claim);
          }
        }
        return Result.ok({
          claims: [...unique.values()]
            .toSorted(
              (a, b) =>
                a.blockIndex - b.blockIndex || a.anchor.start - b.anchor.start,
            )
            .slice(0, VERIFICATION_LIMITS.CLAIMS_PER_RUN_MAX),
          unread: unreadParts(
            pieces,
            passages,
            unread.map(({ window }) => window),
          ),
        });
      },
      catch: (cause) => {
        call.captureError(cause);
        return new WorkflowIntegrationError({
          message: "Claim extraction failed",
          cause,
        });
      },
    }),
  );
};
