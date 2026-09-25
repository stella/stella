/**
 * Wire-shaped AVT fixtures for the logic tests, pinned to the verification
 * API's response types so a change to the contract breaks them loudly.
 */

import type {
  ClaimReview,
  ClaimVerdict,
  EvidenceFact,
  VerificationClaim,
  VerificationRun,
} from "@/features/avt/types";
import { toSafeId } from "@/lib/safe-id";

const uuid = (suffix: number) =>
  `0199a3c4-5b6d-7e8f-9a0b-${String(suffix).padStart(12, "0")}`;

export const factId = (suffix: number) => toSafeId<"entity">(uuid(suffix));

export const claimId = (suffix: number) =>
  toSafeId<"legalListClaim">(uuid(1000 + suffix));

export const makeFact = (
  suffix: number,
  overrides: Partial<EvidenceFact> = {},
): EvidenceFact => ({
  factEntityId: factId(suffix),
  text: `Fact ${String(suffix)}`,
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  confidence: "high",
  interpretationNote: null,
  sources: [],
  ...overrides,
});

type MakeClaimArgs = {
  suffix: number;
  verdict: ClaimVerdict;
  type?: VerificationClaim["type"];
  refs?: VerificationClaim["refs"];
  review?: ClaimReview | null;
  anchor?: VerificationClaim["anchor"];
};

export const makeClaim = ({
  suffix,
  verdict,
  type = "fact",
  refs = [],
  review = null,
  anchor = {
    type: "docx-block",
    blockId: `b${String(suffix)}`,
    start: 0,
    end: 10,
  },
}: MakeClaimArgs): VerificationClaim => ({
  id: claimId(suffix),
  position: suffix,
  type,
  framing: "asserted",
  verdict,
  text: `Claim ${String(suffix)}`,
  anchor,
  refs,
  review,
});

export const makeRun = (
  claims: VerificationClaim[],
  facts: EvidenceFact[] = [],
): VerificationRun => ({
  id: toSafeId<"legalListVerificationRun">(uuid(9000)),
  entityId: toSafeId<"entity">(uuid(9001)),
  fileFieldId: toSafeId<"field">(uuid(9002)),
  entityVersionId: toSafeId<"entityVersion">(uuid(9003)),
  evidence: { listId: toSafeId<"legalList">(uuid(9004)), facts },
  status: "completed",
  errorCode: null,
  pipelineVersion: 1,
  modelRef: null,
  requestedBy: null,
  createdAt: "2026-09-01T09:00:00.000Z",
  startedAt: "2026-09-01T09:00:01.000Z",
  finishedAt: "2026-09-01T09:01:00.000Z",
  claims,
});

export const supported = (score = 90): ClaimVerdict => ({
  state: "supported",
  score,
  recordConflict: null,
});

export const contradicted = (score = 10): ClaimVerdict => ({
  state: "contradicted",
  score,
  recordConflict: null,
});

export const noCover: ClaimVerdict = {
  state: "nocover",
  score: null,
  recordConflict: null,
};

export const notVerifiable: ClaimVerdict = {
  state: "notverifiable",
  score: null,
  recordConflict: null,
};

/** Withheld between fact 5 (governs → supported) and fact 6 (→ contradicted). */
export const recordConflict: ClaimVerdict = {
  state: "recordconflict",
  score: null,
  recordConflict: {
    subject: "Date of the drawdown",
    factEntityIds: [factId(5), factId(6)],
    values: ["5 July 2021", "28 July 2021"],
    governingStates: ["supported", "contradicted"],
  },
};
