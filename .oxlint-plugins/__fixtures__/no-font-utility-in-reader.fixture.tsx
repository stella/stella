// Passive regression fixture for
// `no-font-utility-in-reader/no-font-utility-in-reader`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { cn } from "@stll/ui/utils";

const extra = "";

// --- Flagged: a reader element names its own face ---
export const _a = () => (
  // oxlint-disable-next-line no-font-utility-in-reader/no-font-utility-in-reader
  <p className="text-muted-foreground font-sans text-xs">reference</p>
);
export const _b = () => (
  // oxlint-disable-next-line no-font-utility-in-reader/no-font-utility-in-reader
  <span className={cn("font-serif text-sm", extra)}>wording</span>
);
export const _c = () => (
  // oxlint-disable-next-line no-font-utility-in-reader/no-font-utility-in-reader
  <div className={`md:font-mono ${extra}`}>code</div>
);
// A variant map is a class string like any other.
export const HEADING_CLASS = {
  // oxlint-disable-next-line no-font-utility-in-reader/no-font-utility-in-reader
  1: "font-sans text-lg",
};

// --- Allowed: the named classes, and utilities that are not a family ---
export const _d = () => (
  <p className="reader-chrome text-muted-foreground text-xs">reference</p>
);
export const _e = () => <span className="reader-body text-sm">wording</span>;
// expect-clean: no-font-utility-in-reader/no-font-utility-in-reader
export const _f = () => <h1 className="text-xl font-semibold">title</h1>;
export const _g = () => (
  <span className={cn("font-medium tracking-wide", extra)}>designation</span>
);
