// A module that reads the completion decision: status words restating the
// owner's reading one to one are the owner's word; any other is not.
import {
  decideTemplateFillCompletion,
  templateFillStatus,
} from "@/api/lib/templates/template-fill-completion";

declare const decideElsewhere: (input: unknown) => {
  type: "complete" | "partial" | "rejected_partial";
};

const completion = decideTemplateFillCompletion({});
const fillStatus = templateFillStatus({});
const elsewhere = decideElsewhere({});

const restated = {
  // expect-clean: fill-diagnostics/fill-status-literal-in-owner
  completionStatus: completion.type === "complete" ? "complete" : "partial",
};

const translated = {
  // expect-clean: fill-diagnostics/fill-status-literal-in-owner
  completionStatus: fillStatus === "success" ? "complete" : "partial",
};

const swapped = {
  // The branches disagree with the reading.
  // oxlint-disable-next-line fill-diagnostics/fill-status-literal-in-owner -- x2
  completionStatus: completion.type === "complete" ? "partial" : "complete",
};

const notComplete = {
  // Not partial is complete or rejected: no one-to-one word for it.
  // oxlint-disable-next-line fill-diagnostics/fill-status-literal-in-owner -- x2
  completionStatus: completion.type === "partial" ? "partial" : "complete",
};

const unowned = {
  // A reading the owner did not produce maps nothing.
  // oxlint-disable-next-line fill-diagnostics/fill-status-literal-in-owner -- x2
  completionStatus: elsewhere.type === "complete" ? "complete" : "partial",
};

export const __fillDiagnosticsOwnerReadingFixture = {
  restated,
  translated,
  swapped,
  notComplete,
  unowned,
};
