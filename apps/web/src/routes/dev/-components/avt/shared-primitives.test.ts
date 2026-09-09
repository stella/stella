import { expect, test } from "bun:test";

import type {
  CLAIM_TEXT,
  DOCUMENT,
} from "@/routes/dev/-components/avt/sample-data";
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
} from "@/routes/dev/-components/avt/state-chip";
import type {
  CONFIDENCE_LEVELS,
  CLAIM_TYPE_META,
  STATE_META,
  ClaimFactRelation,
  RecordConflictBoundary,
} from "@/routes/dev/-components/avt/types";
import type {
  DispositionTone,
  confirmLabel,
  countClaims,
  dispositionGuidance,
  isContested,
  isSettled,
  needsAttention,
  resolveClaimView,
} from "@/routes/dev/-components/avt/verdict";

type SharedPrimitiveExports = [
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
