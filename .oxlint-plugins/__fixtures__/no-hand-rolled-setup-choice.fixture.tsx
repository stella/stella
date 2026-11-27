// Passive regression fixture for
// `no-hand-rolled-setup-choice/no-hand-rolled-setup-choice`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { Label } from "@stll/ui/label";

const ChoiceGroup = ({ children }: { children: string }) => (
  <section>{children}</section>
);

// --- Flagged: radio cards drawn by hand on a setup screen ---
export const _a = () => (
  // oxlint-disable-next-line no-hand-rolled-setup-choice/no-hand-rolled-setup-choice
  <input name="choice" type="radio" value="one" />
);
export const _b = () => (
  // oxlint-disable-next-line no-hand-rolled-setup-choice/no-hand-rolled-setup-choice
  <div aria-label="Choice" role="radiogroup" />
);
export const _c = () => (
  // oxlint-disable-next-line no-hand-rolled-setup-choice/no-hand-rolled-setup-choice
  <Label htmlFor="one" variant="choice-card">One</Label>
);
export const _d = () => (
  // oxlint-disable-next-line no-hand-rolled-setup-choice/no-hand-rolled-setup-choice
  <Label htmlFor="one" variant={"choice"}>One</Label>
);

// --- Allowed: the shared parts, and controls that are not a choice card ---
// expect-clean: no-hand-rolled-setup-choice/no-hand-rolled-setup-choice
export const _e = () => <ChoiceGroup>cards</ChoiceGroup>;
export const _f = () => <input type="checkbox" />;
export const _g = () => <Label htmlFor="name">Name</Label>;
export const _h = () => <div role="group" />;
