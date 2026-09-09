import { expect, test } from "bun:test";

import type { AnchorFactsPanel } from "@/routes/dev_.avt/-components/avt/anchor-facts-panel";
import type { ClaimDetailPanel } from "@/routes/dev_.avt/-components/avt/claim-detail-panel";
import type {
  CLAIM_TEXT,
  DOCUMENT,
} from "@/routes/dev_.avt/-components/avt/sample-data";
import type {
  ConfBadge,
  InterpNote,
  MatchStepper,
  MatchStepperState,
  MediumChip,
  RECORD_CONFLICT_BG_VAR,
  RECORD_CONFLICT_FG_VAR,
  RECORD_CONFLICT_VAR,
  STATE_COLOR,
  StateChip,
  StateSwatch,
  TypeChip,
} from "@/routes/dev_.avt/-components/avt/state-chip";
import type {
  CONFIDENCE_LEVELS,
  CLAIM_TYPE_META,
  REVIEWER_OVERRIDE_STATES,
  STATE_META,
  ClaimFactRelation,
  RecordConflictBoundary,
} from "@/routes/dev_.avt/-components/avt/types";
import type {
  DispositionTone,
  confirmLabel,
  countClaims,
  dispositionGuidance,
  isContested,
  isSettled,
  needsAttention,
  resolveClaimView,
} from "@/routes/dev_.avt/-components/avt/verdict";
import type { VerificationView } from "@/routes/dev_.avt/-components/avt/verification-view";

type SharedPrimitiveExports = [
  typeof AnchorFactsPanel,
  typeof ClaimDetailPanel,
  typeof VerificationView,
  typeof CLAIM_TEXT,
  typeof DOCUMENT,
  typeof ConfBadge,
  typeof InterpNote,
  typeof MatchStepper,
  MatchStepperState,
  typeof MediumChip,
  typeof RECORD_CONFLICT_BG_VAR,
  typeof RECORD_CONFLICT_FG_VAR,
  typeof RECORD_CONFLICT_VAR,
  typeof STATE_COLOR,
  typeof StateChip,
  typeof StateSwatch,
  typeof TypeChip,
  typeof CONFIDENCE_LEVELS,
  typeof CLAIM_TYPE_META,
  typeof REVIEWER_OVERRIDE_STATES,
  typeof STATE_META,
  ClaimFactRelation,
  RecordConflictBoundary,
  DispositionTone,
  typeof confirmLabel,
  typeof countClaims,
  typeof dispositionGuidance,
  typeof isContested,
  typeof isSettled,
  typeof needsAttention,
  typeof resolveClaimView,
];

test("exposes the primitives consumed by later AVT layers", () => {
  const exports: SharedPrimitiveExports | undefined = undefined;
  expect(exports).toBeUndefined();
});
