// Passive regression fixture for
// `no-justified-reader-text/no-justified-reader-text`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { cn } from "@stll/ui/utils";

const extra = "";

// --- Flagged: reader text set justified ---
export const _a = () => (
  // oxlint-disable-next-line no-justified-reader-text/no-justified-reader-text
  <p className="text-justify text-xs">reasoning</p>
);
export const _b = () => (
  // oxlint-disable-next-line no-justified-reader-text/no-justified-reader-text
  <span className={cn("lg:text-justify", extra)}>holding</span>
);
export const _c = () => (
  // oxlint-disable-next-line no-justified-reader-text/no-justified-reader-text
  <p style={{ textAlign: "justify" }}>abstract</p>
);
// oxlint-disable-next-line no-justified-reader-text/no-justified-reader-text
export const READER_CSS = "p { text-align: justify; }";

// --- Allowed: start alignment, other alignments, layout justification ---
// expect-clean: no-justified-reader-text/no-justified-reader-text
export const _d = () => <p className="reader-prose">reasoning</p>;
export const _e = () => <p className="text-center">closing</p>;
export const _f = () => (
  <div className="flex justify-between">
    <p style={{ textAlign: "start" }}>signature</p>
  </div>
);
