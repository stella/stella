// Passive regression fixture for
// `text-mark-not-in-button/text-mark-not-in-button`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { Button, ButtonTextRun } from "@stll/ui/button";
import { TextMark, textMarkClass } from "@stll/ui/text-mark";

const select = () => undefined;

// --- Flagged: a text mark inside a Button ---
export const MarkedClaim = () => (
  // oxlint-disable-next-line text-mark-not-in-button/text-mark-not-in-button
  <Button onClick={select} variant="plain">
    <span className={textMarkClass({ variant: "underline", tone: "success" })}>Funds arrived</span>
  </Button>
);

export const MarkedCitation = () => (
  // oxlint-disable-next-line text-mark-not-in-button/text-mark-not-in-button
  <Button onClick={select} variant="plain">
    <TextMark tone="muted" variant="fill">the agreement</TextMark>
  </Button>
);

// --- Allowed: the same marks as a text run, and a Button without a mark ---
export const ClaimRun = () => (
  <ButtonTextRun onClick={select}>
    <span className={textMarkClass({ variant: "underline", tone: "success" })}>Funds arrived</span>
  </ButtonTextRun>
);

export const PlainAction = () => (
  <Button onClick={select} variant="outline">
    Open
  </Button>
);
