// Passive regression fixture for `no-ad-hoc-text-mark/no-ad-hoc-text-mark`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import {
  SEARCH_HIT_DESCENDANT_MARK_CLASS,
  SEARCH_HIT_MARK,
  TextMark,
  textMarkClass,
} from "@stll/ui/text-mark";
import { cn } from "@stll/ui/utils";

// --- Flagged: a hand-rolled mark element, descendant styling, the old fill ---
export const _a = () => (
  // oxlint-disable-next-line no-ad-hoc-text-mark/no-ad-hoc-text-mark
  <mark>found</mark>
);
// oxlint-disable-next-line no-ad-hoc-text-mark/no-ad-hoc-text-mark
const descendant = "text-xs [&_mark]:bg-warning/30";
// oxlint-disable-next-line no-ad-hoc-text-mark/no-ad-hoc-text-mark
const darkDescendant = `dark:[&_mark]:bg-warning/20`;
// oxlint-disable-next-line no-ad-hoc-text-mark/no-ad-hoc-text-mark
const retiredFill = "absolute bg-highlight/45";

// --- Allowed: the owned mark, its class builder and descendant class ---
// expect-clean: no-ad-hoc-text-mark/no-ad-hoc-text-mark
export const _ok1 = () => <TextMark {...SEARCH_HIT_MARK}>found</TextMark>;
export const _ok2 = () => (
  <p className={cn("text-xs", SEARCH_HIT_DESCENDANT_MARK_CLASS)} />
);
export const _ok3 = () => (
  <div className={textMarkClass({ variant: "fill", tone: "warning" })} />
);
const badgeTone = "text-highlight-foreground bg-warning/30";

export { badgeTone, darkDescendant, descendant, retiredFill };
