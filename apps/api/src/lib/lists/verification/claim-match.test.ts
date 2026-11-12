import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  CLAIM_MATCH_SIMILARITY_MIN,
  claimTextSimilarity,
  matchClaims,
  normaliseClaimText,
} from "@/api/lib/lists/verification/claim-match";
import type {
  ClaimMatch,
  MatchableClaim,
} from "@/api/lib/lists/verification/claim-match";
import type { ClaimAnchor } from "@/api/lib/lists/verification/contract";

type Claim = MatchableClaim<string>;

const anchorIn = (block: number): ClaimAnchor => ({
  type: "docx-block",
  blockId: `p${String(block)}`,
  start: 0,
  end: 1,
});

const blockOf = ({ anchor }: Claim) =>
  anchor.type === "docx-block" ? anchor.blockId : String(anchor.pageNumber);

/** A lower-case ASCII letter, a to z. */
const letters = fc
  .integer({ min: 97, max: 122 })
  .map((code) => String.fromCodePoint(code));
const word = fc
  .array(letters, { minLength: 3, maxLength: 8 })
  .map((chars) => chars.join(""));
/** Long enough that one word changed stays above the threshold. */
const sentence = fc.array(word, { minLength: 10, maxLength: 16 });

/** Claims with pairwise different words, each in a block of its own. */
const distinctClaims = fc
  .uniqueArray(sentence, {
    minLength: 1,
    maxLength: 12,
    selector: (words) => normaliseClaimText(words.join(" ")),
  })
  .map((sentences) =>
    sentences.map((words, index): Claim => ({
      id: `old-${String(index)}`,
      text: words.join(" "),
      anchor: anchorIn(index),
    })),
  );

/** The same claims under new ids, in another order and other blocks. */
const reordered = (claims: readonly Claim[], order: readonly number[]) =>
  order.map((from, index): Claim => ({
    id: `new-${String(from)}`,
    text: claims.at(from)?.text ?? "",
    anchor: anchorIn(index + 100),
  }));

const permutation = (length: number) =>
  fc.array(fc.nat(), { minLength: length, maxLength: length }).map((keys) =>
    keys
      .map((key, index) => ({ key, index }))
      .toSorted((a, b) => a.key - b.key || a.index - b.index)
      .map(({ index }) => index),
  );

const targetOf = (match: ClaimMatch<string> | undefined) =>
  match?.type === "matched" || match?.type === "changed-text"
    ? match.targetId
    : null;

describe("claim text normalisation", () => {
  test("ignores case, spacing, and quote and dash styles", () => {
    const written = "The  Board’s “approval” came —\tlater";
    expect(written).not.toBe('the board\'s "approval" came - later');
    expect(normaliseClaimText(written)).toBe(
      'the board\'s "approval" came - later',
    );
  });

  test("folds compatibility forms, so a ligature reads as its letters", () => {
    expect("ﬁled").not.toBe("filed");
    expect(normaliseClaimText("ﬁled")).toBe(normaliseClaimText("filed"));
  });
});

describe("claim matching (properties)", () => {
  test("INVARIANT: every claim finds itself after the claims are reordered and moved", () => {
    assertProperty(
      "INVARIANT: every claim finds itself after the claims are reordered and moved",
      fc.property(
        distinctClaims.chain((claims) =>
          fc.tuple(fc.constant(claims), permutation(claims.length)),
        ),
        ([claims, order]) => {
          const matches = matchClaims(claims, reordered(claims, order));
          for (const [index, claim] of claims.entries()) {
            expect(matches.get(claim.id)).toEqual({
              type: "matched",
              targetId: `new-${String(index)}`,
            });
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("INVARIANT: a claim with one word changed is found in its own block", () => {
    assertProperty(
      "INVARIANT: a claim with one word changed is found in its own block",
      fc.property(
        distinctClaims.chain((claims) =>
          fc.tuple(
            fc.constant(claims),
            fc.nat({ max: claims.length - 1 }),
            fc.nat(),
          ),
        ),
        ([claims, edited, at]) => {
          const target = claims.map((claim, index): Claim => {
            if (index !== edited) {
              return { ...claim, id: `new-${String(index)}` };
            }
            const words = claim.text.split(" ");
            words[at % words.length] = "1234";
            return { ...claim, id: "new-edited", text: words.join(" ") };
          });
          const editedClaim = claims.at(edited);
          const editedTarget = target.at(edited);
          // The fixture reaches the second pass: the words differ.
          expect(editedTarget?.text).not.toBe(editedClaim?.text);

          const matches = matchClaims(claims, target);
          const match = matches.get(editedClaim?.id ?? "");
          expect(match?.type).toBe("changed-text");
          expect(targetOf(match)).toBe("new-edited");
          for (const [index, claim] of claims.entries()) {
            if (index !== edited) {
              expect(targetOf(matches.get(claim.id))).toBe(
                `new-${String(index)}`,
              );
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("INVARIANT: words found twice in the new run match neither copy", () => {
    assertProperty(
      "INVARIANT: words found twice in the new run match neither copy",
      fc.property(
        distinctClaims.chain((claims) =>
          fc.tuple(fc.constant(claims), fc.nat({ max: claims.length - 1 })),
        ),
        ([claims, doubled]) => {
          const copy =
            claims.at(doubled) ?? panic("The doubled claim is in range");
          const target: Claim[] = [
            ...claims.map((claim, index) => ({
              ...claim,
              id: `new-${String(index)}`,
            })),
            { ...copy, id: "new-copy", anchor: anchorIn(999) },
          ];
          const matches = matchClaims(claims, target);
          expect(matches.get(copy.id)).toEqual({ type: "ambiguous" });
          const targets = [...matches.values()].map(targetOf);
          expect(targets).not.toContain("new-copy");
          expect(targets).not.toContain(`new-${String(doubled)}`);
        },
      ),
      { numRuns: 200 },
    );
  });

  // A small vocabulary and few blocks force repeated and near-identical
  // claims, the inputs where a guess would be tempting.
  const crowdedClaims = (prefix: string) =>
    fc
      .array(
        fc.tuple(
          fc.array(fc.constantFrom("paid", "late", "the", "fee", "board"), {
            minLength: 1,
            maxLength: 6,
          }),
          fc.nat({ max: 3 }),
        ),
        { maxLength: 10 },
      )
      .map((rows) =>
        rows.map(([words, block], index): Claim => ({
          id: `${prefix}-${String(index)}`,
          text: words.join(" "),
          anchor: anchorIn(block),
        })),
      );

  test("INVARIANT: matching is total, one-to-one and only pairs what it may", () => {
    assertProperty(
      "INVARIANT: matching is total, one-to-one and only pairs what it may",
      fc.property(
        crowdedClaims("old"),
        crowdedClaims("new"),
        (source, target) => {
          const matches = matchClaims(source, target);
          expect([...matches.keys()].toSorted()).toEqual(
            source.map(({ id }) => id).toSorted(),
          );
          const byId = new Map(target.map((claim) => [claim.id, claim]));
          const paired = [...matches.values()].flatMap((match) => {
            const id = targetOf(match);
            return id === null ? [] : [id];
          });
          expect(new Set(paired).size).toBe(paired.length);
          for (const claim of source) {
            const match = matches.get(claim.id);
            const other = byId.get(targetOf(match) ?? "");
            if (match?.type === "matched") {
              expect(normaliseClaimText(other?.text ?? "")).toBe(
                normaliseClaimText(claim.text),
              );
            }
            if (match?.type === "changed-text" && other !== undefined) {
              expect(blockOf(other)).toBe(blockOf(claim));
              expect(match.similarity).toBeGreaterThanOrEqual(
                CLAIM_MATCH_SIMILARITY_MIN,
              );
              expect(claimTextSimilarity(claim.text, other.text)).toBe(
                match.similarity,
              );
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("claim matching", () => {
  test("a rewritten claim in another block is unmatched, not guessed", () => {
    const matches = matchClaims(
      [
        {
          id: "old",
          text: "The payment was made on 9 March by bank transfer.",
          anchor: anchorIn(1),
        },
      ],
      [
        {
          id: "new",
          text: "The payment was made on 9 March by wire transfer.",
          anchor: anchorIn(2),
        },
      ],
    );
    expect(matches.get("old")).toEqual({ type: "unmatched" });
  });

  test("swapped parties in the same paragraph do not read as the same claim", () => {
    const old = "The seller shall pay the buyer";
    const swapped = "The buyer shall pay the seller";
    // The fixture reaches the second pass: the words differ, the bag of
    // words does not.
    expect(normaliseClaimText(swapped)).not.toBe(normaliseClaimText(old));
    expect(normaliseClaimText(swapped).split(" ").toSorted()).toEqual(
      normaliseClaimText(old).split(" ").toSorted(),
    );
    const matches = matchClaims(
      [{ id: "old", text: old, anchor: anchorIn(1) }],
      [{ id: "new", text: swapped, anchor: anchorIn(1) }],
    );
    expect(matches.get("old")).toEqual({ type: "unmatched" });
  });

  test("two edited claims that fit one new claim are ambiguous", () => {
    const old = (id: string, text: string): Claim => ({
      id,
      text,
      anchor: anchorIn(1),
    });
    const matches = matchClaims(
      [
        old("a", "The board approved the transfer on 9 March 2024 in Prague."),
        old("b", "The board approved the transfer on 9 March 2024 in Brno."),
      ],
      [old("new", "The board approved the transfer on 9 March 2024 in Plzeň.")],
    );
    expect(matches.get("a")).toEqual({ type: "ambiguous" });
    expect(matches.get("b")).toEqual({ type: "ambiguous" });
  });
});
