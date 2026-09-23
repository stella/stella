import { expect, test } from "bun:test";

import type { AnchorFactsPanel } from "@/features/avt/anchor-facts-panel";
import type { ClaimDetailPanel } from "@/features/avt/claim-detail-panel";
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
  SaveIndicator,
  StateChip,
  StateSwatch,
  TypeChip,
} from "@/features/avt/state-chip";
import type {
  CLAIM_OVERRIDE_STATES,
  CLAIM_TYPE_META,
  ClaimFactRelation,
  FACT_CONFIDENCES,
  STATE_META,
} from "@/features/avt/types";
import type {
  DispositionTone,
  confirmLabel,
  countClaims,
  dispositionGuidance,
  isContested,
  isSettled,
  needsAttention,
  resolveClaimView,
} from "@/features/avt/verdict";
import type { VerificationView } from "@/features/avt/verification-view";

type SharedPrimitiveExports = [
  typeof AnchorFactsPanel,
  typeof ClaimDetailPanel,
  typeof VerificationView,
  typeof ConfBadge,
  typeof InterpNote,
  typeof MatchStepper,
  MatchStepperState,
  typeof MediumChip,
  typeof RECORD_CONFLICT_BG_VAR,
  typeof RECORD_CONFLICT_FG_VAR,
  typeof RECORD_CONFLICT_VAR,
  typeof STATE_COLOR,
  typeof SaveIndicator,
  typeof StateChip,
  typeof StateSwatch,
  typeof TypeChip,
  typeof FACT_CONFIDENCES,
  typeof CLAIM_TYPE_META,
  typeof CLAIM_OVERRIDE_STATES,
  typeof STATE_META,
  ClaimFactRelation,
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
