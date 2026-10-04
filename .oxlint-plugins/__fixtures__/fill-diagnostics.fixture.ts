import { templateFills } from "@/api/db/schema";
import {
  // A diagnostic producer the fill service composes, imported by a consumer.
  // oxlint-disable-next-line fill-diagnostics/fill-consumer-reads-decision
  resolveAiFields,
} from "@/api/lib/docx/resolve-ai-fields";
// expect-clean: fill-diagnostics/fill-consumer-reads-decision
import { describeFillShortfall } from "@/api/lib/templates/template-fill-completion";
import {
  // Runs a fill, and nothing in this module reads its completion decision.
  // oxlint-disable-next-line fill-diagnostics/fill-consumer-reads-decision
  fillStoredTemplate,
} from "@/api/lib/templates/template-fill-service";

declare const tx: { insert: (table: unknown) => unknown };
declare const otherTable: unknown;
declare const filled: {
  aiFieldErrors: readonly string[];
  unmatchedPlaceholders: readonly string[];
  structureErrors: readonly string[];
  unrestoredFields: readonly string[];
};
const outcome: { status: string; title: string } = { status: "", title: "" };

// A consumer deciding the fill from one kind and writing the status itself.
// oxlint-disable-next-line fill-diagnostics/no-raw-diagnostic-decision
const complete = filled.aiFieldErrors.length === 0;
// oxlint-disable-next-line fill-diagnostics/no-raw-diagnostic-decision
if (filled.unmatchedPlaceholders.length === 0) {
  // oxlint-disable-next-line fill-diagnostics/fill-status-literal-in-owner
  outcome.status = "success";
}

// Testing a kind only to present that same kind is not a verdict.
// expect-clean: fill-diagnostics/no-raw-diagnostic-decision
const listed =
  filled.structureErrors.length > 0 ? filled.structureErrors : null;

// A placeholder the anonymizing boundary could not restore is a kind too.
// oxlint-disable-next-line fill-diagnostics/no-raw-diagnostic-decision
const restored = filled.unrestoredFields.length === 0;

// Passing a base on unchanged when the kind is empty only presents the kind.
declare const graded: { completionStatus: string };
// expect-clean: fill-diagnostics/no-raw-diagnostic-decision
const reported =
  filled.unrestoredFields.length === 0
    ? graded
    : { ...graded, unrestoredFields: filled.unrestoredFields };

// A status word outside a status slot is ordinary text.
// expect-clean: fill-diagnostics/fill-status-literal-in-owner
outcome.title = "success";
// A producer returning a new channel beside the diagnostics record.
type ProducedFill = {
  structureErrors: readonly string[];
  // oxlint-disable-next-line fill-diagnostics/no-diagnostic-channel-outside-record
  fooWarnings: readonly string[];
};
const produced: ProducedFill = {
  // expect-clean: fill-diagnostics/no-diagnostic-channel-outside-record
  structureErrors: [],
  // oxlint-disable-next-line fill-diagnostics/no-diagnostic-channel-outside-record
  fooWarnings: [],
};

// A fill row written past the recorder.
// oxlint-disable-next-line fill-diagnostics/fill-row-through-recorder
const _row = tx.insert(templateFills);
// expect-clean: fill-diagnostics/fill-row-through-recorder
const _other = tx.insert(otherTable);

export const __fillDiagnosticsFixture = {
  resolveAiFields,
  describeFillShortfall,
  fillStoredTemplate,
  complete,
  listed,
  restored,
  reported,
  produced,
  _row,
  _other,
};
