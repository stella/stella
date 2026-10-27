// Passive regression fixture for
// `no-sm-breakpoint-in-desktop/no-sm-breakpoint-in-desktop`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { cn } from "@stll/ui/utils";

const extra = "";

// --- Flagged: a viewport breakpoint in a desktop window ---
export const _a = () => (
  // oxlint-disable-next-line no-sm-breakpoint-in-desktop/no-sm-breakpoint-in-desktop
  <div className="grid sm:grid-cols-3">row</div>
);
export const _b = () => (
  // oxlint-disable-next-line no-sm-breakpoint-in-desktop/no-sm-breakpoint-in-desktop
  <p className={cn("max-sm:hidden", extra)}>hint</p>
);

// --- Allowed: explicit window widths and pinned sizes ---
// expect-clean: no-sm-breakpoint-in-desktop/no-sm-breakpoint-in-desktop
export const _c = () => (
  <div className="grid min-[40rem]:grid-cols-3">row</div>
);
export const _d = () => <input className="h-11 text-base sm:text-base" />;
