/**
 * Which jurisdictions stay on the newer generation when a family is served
 * by the previous one again.
 *
 * A forward flip `from -> to` may record, as an explicit input of `serve`,
 * that named jurisdictions stay on `to` if the family later falls back to
 * `from`. The policy is validated when the flip records it (case law only,
 * the exact pair of that flip, at least one jurisdiction, each declared and
 * held by both generations, both generations on one cluster) and stored in
 * the flip's receipt; nothing infers it.
 *
 * It applies to one transition only: the family served by `to` because of
 * that very flip (its receipt is the family's latest) being served by `from`
 * again. Any other transition, a fallback to a third generation or one after
 * a later flip, finds no policy and moves every jurisdiction as before.
 *
 * `readCorpusIndexFallbackKeepTx` is the one reader. The serving mutation
 * (`setServingCorpusIndexGenerationTx`) applies what it answers, so every
 * caller of that mutation keeps the named jurisdictions on the newer
 * generation, through the jurisdiction-serving pointer; the guarded flip
 * reads it too, to compare only the jurisdictions whose readers move.
 */
import { panic, Result } from "better-result";
import { desc, eq } from "drizzle-orm";

import { isCaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerationFlips } from "@/api/db/schema";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  corpusIndexManifestCoversJurisdiction,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { isRecord } from "@/api/lib/type-guards";

type ReadTransaction = Pick<Transaction, "select">;

/**
 * Recorded by a forward flip `fromGeneration -> toGeneration`: on a later
 * fallback to `fromGeneration`, `keepOnNewer` stay on `toGeneration`.
 */
export type CorpusIndexFallbackPolicy = {
  fromGeneration: string;
  toGeneration: string;
  /** Canonical jurisdiction codes, as decisions and pointers carry them. */
  keepOnNewer: readonly string[];
};

export type CorpusIndexFallbackPolicyRefusalReason =
  | "family_unsupported"
  | "pair_mismatch"
  | "no_jurisdictions"
  | "duplicate_jurisdiction"
  | "undeclared_jurisdiction"
  | "cluster_mismatch";

export type CorpusIndexFallbackPolicyRefusal = {
  reason: CorpusIndexFallbackPolicyRefusalReason;
  message: string;
};

const refuse = (
  reason: CorpusIndexFallbackPolicyRefusalReason,
  message: string,
) => Result.err<CorpusIndexFallbackPolicyRefusal>({ reason, message });

/**
 * The policy as the flip `from -> to` of `family` may record it, or why not.
 * Codes are taken exactly as given: a lowercase or unknown code is refused,
 * never mapped to a declared one.
 */
export const validateCorpusIndexFallbackPolicy = (
  policy: CorpusIndexFallbackPolicy,
  {
    family,
    from,
    to,
  }: { family: CorpusFamily; from: string | null; to: string },
): Result<CorpusIndexFallbackPolicy, CorpusIndexFallbackPolicyRefusal> => {
  // Only case-law readers and erasures follow the jurisdiction-serving
  // pointer; legislation has none.
  if (family !== "case_law") {
    return refuse(
      "family_unsupported",
      `A fallback policy keeps case-law jurisdictions only, not ${family}`,
    );
  }
  if (
    from === null ||
    policy.fromGeneration !== from ||
    policy.toGeneration !== to
  ) {
    return refuse(
      "pair_mismatch",
      `The fallback policy names ${policy.fromGeneration} -> ${policy.toGeneration}, but this flip is ${from ?? "(none)"} -> ${to}`,
    );
  }
  if (policy.keepOnNewer.length === 0) {
    return refuse(
      "no_jurisdictions",
      "A fallback policy names at least one jurisdiction to keep",
    );
  }
  if (new Set(policy.keepOnNewer).size !== policy.keepOnNewer.length) {
    return refuse(
      "duplicate_jurisdiction",
      `The fallback policy names a jurisdiction twice: ${policy.keepOnNewer.join(", ")}`,
    );
  }
  const fromManifest = requireCorpusIndexManifest(family, from);
  const toManifest = requireCorpusIndexManifest(family, to);
  const undeclared = policy.keepOnNewer.filter(
    (jurisdiction) =>
      !isCaseLawJurisdiction(jurisdiction) ||
      !corpusIndexManifestCoversJurisdiction(fromManifest, jurisdiction) ||
      !corpusIndexManifestCoversJurisdiction(toManifest, jurisdiction),
  );
  if (undeclared.length > 0) {
    return refuse(
      "undeclared_jurisdiction",
      `Not a jurisdiction both ${from} and ${to} hold: ${undeclared.join(", ")}`,
    );
  }
  // One read spans the generation serving the family and the one a kept
  // jurisdiction stays on.
  if (fromManifest.cluster !== toManifest.cluster) {
    return refuse(
      "cluster_mismatch",
      `${from} lives on ${fromManifest.cluster} and ${to} on ${toManifest.cluster}; one read cannot span both`,
    );
  }
  return Result.ok({
    fromGeneration: policy.fromGeneration,
    toGeneration: policy.toGeneration,
    keepOnNewer: policy.keepOnNewer.toSorted(),
  });
};

/** The policy a fallback applies: the receipt that recorded it, and what it keeps. */
export type CorpusIndexFallbackKeep = {
  receiptId: string;
  keepOnNewer: readonly string[];
};

/** The policy as a receipt stores it under `evidence.rollbackPolicy`. */
const storedPolicy = (value: unknown): CorpusIndexFallbackPolicy | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const keep = isRecord(value) ? value["keepOnNewer"] : undefined;
  if (
    !isRecord(value) ||
    typeof value["fromGeneration"] !== "string" ||
    typeof value["toGeneration"] !== "string" ||
    !Array.isArray(keep) ||
    keep.length === 0 ||
    !keep.every((entry) => typeof entry === "string")
  ) {
    return panic("A flip receipt holds a malformed fallback policy");
  }
  return {
    fromGeneration: value["fromGeneration"],
    toGeneration: value["toGeneration"],
    keepOnNewer: keep.filter((entry) => typeof entry === "string"),
  };
};

/**
 * What a move of `family` from `serving` to `target` keeps on `serving`: the
 * policy of the family's latest flip receipt, when that flip was exactly
 * `target -> serving` and recorded one for that pair; otherwise null, and
 * every jurisdiction moves.
 */
export const readCorpusIndexFallbackKeepTx = async (
  tx: ReadTransaction,
  {
    family,
    serving,
    target,
  }: { family: CorpusFamily; serving: string; target: string },
): Promise<CorpusIndexFallbackKeep | null> => {
  const flips = corpusIndexGenerationFlips;
  const latest = (
    await tx
      .select({
        id: flips.id,
        fromGeneration: flips.fromGeneration,
        toGeneration: flips.toGeneration,
        evidence: flips.evidence,
      })
      .from(flips)
      .where(eq(flips.family, family))
      .orderBy(desc(flips.flippedAt), desc(flips.id))
      .limit(1)
  ).at(0);
  if (
    latest === undefined ||
    latest.toGeneration !== serving ||
    latest.fromGeneration !== target
  ) {
    return null;
  }
  const policy = storedPolicy(
    isRecord(latest.evidence) ? latest.evidence["rollbackPolicy"] : null,
  );
  return policy !== null &&
    policy.fromGeneration === target &&
    policy.toGeneration === serving
    ? { receiptId: latest.id, keepOnNewer: policy.keepOnNewer }
    : null;
};
