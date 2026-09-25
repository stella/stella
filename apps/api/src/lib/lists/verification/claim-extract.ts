/**
 * Pass one: find the claims a document makes.
 *
 * The model reads the document one window of blocks at a time, with a few
 * neighbouring blocks for context, and lists each claim as a verbatim quote of the block it sits in. The
 * quote is located in the block's own text here, so a claim's anchor is
 * always the document's words, never the model's paraphrase. A quote that
 * cannot be found is shown back once for correction; one that still cannot
 * be found is not a claim this run can point at.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { mapWithConcurrency } from "@stll/concurrency";

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
} from "@/api/lib/lists/verification/contract";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import {
  blocksText,
  createVerificationCall,
} from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import { locateQuote } from "@/api/lib/lists/verification/quote-locate";

/** Blocks per extraction call: small enough that the model does not skim. */
const WINDOW_BLOCKS = 40;
/** Blocks shown on each side of a window, so a claim split across a block
 *  boundary still reads as one. */
const CONTEXT_BLOCKS = 3;
const CONCURRENCY = 3;

const rawClaimSchema = v.strictObject({
  blockId: v.string(),
  quote: v.string(),
  type: v.picklist(CLAIM_TYPES),
  framing: v.picklist(CLAIM_FRAMINGS),
});

const extractionSchema = v.strictObject({
  claims: v.array(rawClaimSchema),
});

type RawClaim = v.InferOutput<typeof rawClaimSchema>;

export type ExtractedClaim = {
  type: ClaimType;
  framing: ClaimFraming;
  text: string;
  anchor: ClaimAnchor;
  /** Reading order: the block's index, then the offset inside it. */
  blockIndex: number;
};

const SYSTEM_PROMPT = `You list the claims a legal document makes, so each can later be checked against a record of evidence.

A claim is one assertion the document's author makes: a thing that happened, a state of affairs, a date, an amount, who did or knew what. Split compound sentences into separate claims when each part could be true or false on its own. Skip headings, definitions, procedural boilerplate and statements of truth.

For each claim give:
- blockId: the id of the block it is in, exactly as supplied.
- quote: the claim's words copied character for character from that block. Quote only the words that make the claim, never text from another block, never a paraphrase.
- type: fact when the record could confirm or refute it; opinion when it is the author's judgment or characterisation; unverifiable when it is factual in form but nothing outside the author's own mind could bear on it.
- framing: recalled when the author presents it as their own recollection or belief ("I recall", "to the best of my knowledge"); otherwise asserted.

List claims in the order they appear. Only list claims in the blocks you are asked about; the blocks around them are context.`;

type Window = { from: number; to: number };

const windowTask = (
  blocks: readonly VerificationBlock[],
  { from, to }: Window,
): string => {
  const asked = blocks.slice(from, to);
  const context = blocks.slice(
    Math.max(0, from - CONTEXT_BLOCKS),
    Math.min(blocks.length, to + CONTEXT_BLOCKS),
  );
  return `Document blocks:\n${blocksText(context)}\n\nList the claims in these blocks only: ${asked.map((block) => block.id).join(", ")}`;
};

type Grounding =
  | { type: "grounded"; claim: ExtractedClaim }
  | { type: "misquoted"; raw: RawClaim; reason: string };

const ground = (
  raw: RawClaim,
  blockIndexById: ReadonlyMap<string, number>,
  blocks: readonly VerificationBlock[],
  cursor: Map<string, number>,
): Grounding => {
  const blockIndex = blockIndexById.get(raw.blockId);
  const block = blockIndex === undefined ? undefined : blocks.at(blockIndex);
  if (blockIndex === undefined || block === undefined) {
    return {
      type: "misquoted",
      raw,
      reason: "names a block that does not exist",
    };
  }
  const span = locateQuote(block.text, raw.quote, cursor.get(block.id) ?? 0);
  if (span === null) {
    return {
      type: "misquoted",
      raw,
      reason: "is not in that block word for word",
    };
  }
  cursor.set(block.id, span.end);
  const text = block.text
    .slice(span.start, span.end)
    .slice(0, VERIFICATION_LIMITS.CLAIM_TEXT_MAX);
  const anchor: ClaimAnchor =
    block.source.type === "docx-block"
      ? {
          type: "docx-block",
          blockId: block.source.blockId,
          start: span.start,
          end: span.start + text.length,
        }
      : {
          type: "pdf-page",
          pageNumber: block.source.pageNumber,
          start: span.start,
          end: span.start + text.length,
        };
  return {
    type: "grounded",
    claim: { type: raw.type, framing: raw.framing, text, anchor, blockIndex },
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

type ExtractClaimsArgs = {
  blocks: readonly VerificationBlock[];
  deps: VerificationModelDeps;
};

/** Every grounded claim in reading order, capped at the per-run maximum. */
export const extractClaims = async ({
  blocks,
  deps,
}: ExtractClaimsArgs): Promise<
  Result<ExtractedClaim[], WorkflowIntegrationError>
> => {
  const call = createVerificationCall({
    deps,
    feature: "lists.verification.extract",
    system: SYSTEM_PROMPT,
    shared: null,
    outputSchema: extractionSchema,
  });
  const blockIndexById = new Map(
    blocks.map((block, index) => [block.id, index]),
  );
  const windows: Window[] = [];
  for (let from = 0; from < blocks.length; from += WINDOW_BLOCKS) {
    windows.push({ from, to: Math.min(blocks.length, from + WINDOW_BLOCKS) });
  }

  return await Result.tryPromise({
    try: async () => {
      const perWindow = await mapWithConcurrency({
        items: windows,
        limit: CONCURRENCY,
        operation: async (window) => {
          const request = call.request(windowTask(blocks, window));
          const output = await call.generate([request]);
          const cursor = new Map<string, number>();
          const grounded: ExtractedClaim[] = [];
          const misquoted: { raw: RawClaim; reason: string }[] = [];
          for (const raw of output.claims) {
            const result = ground(raw, blockIndexById, blocks, cursor);
            if (result.type === "grounded") {
              grounded.push(result.claim);
            } else {
              misquoted.push(result);
            }
          }
          if (misquoted.length === 0) {
            return grounded;
          }
          const repaired = await call.generate([
            request,
            { role: "assistant", content: JSON.stringify(output) },
            { role: "user", content: repairMessage(misquoted) },
          ]);
          for (const raw of repaired.claims) {
            const result = ground(raw, blockIndexById, blocks, cursor);
            if (result.type === "grounded") {
              grounded.push(result.claim);
            }
          }
          return grounded;
        },
      });
      // A claim listed twice (in two windows, or again in a repair) is one
      // claim: its anchor is its identity.
      const unique = new Map<string, ExtractedClaim>();
      for (const claim of perWindow.flat()) {
        const key = `${String(claim.blockIndex)}:${String(claim.anchor.start)}:${String(claim.anchor.end)}`;
        if (!unique.has(key)) {
          unique.set(key, claim);
        }
      }
      return [...unique.values()]
        .toSorted(
          (a, b) =>
            a.blockIndex - b.blockIndex || a.anchor.start - b.anchor.start,
        )
        .slice(0, VERIFICATION_LIMITS.CLAIMS_PER_RUN_MAX);
    },
    catch: (cause) => {
      call.captureError(cause);
      return new WorkflowIntegrationError({
        message: "Claim extraction failed",
        cause,
      });
    },
  });
};
