import { FaceLabelPending } from "@stll/ui/control-face";

import {
  READER_BODY_STYLE,
  ReaderParagraphsPending,
} from "@/components/legal-reader/reader-text.pending";

/** The masthead's lines, from the act's citation down to its title. */
export const STATUTE_MASTHEAD_CLASS_NAMES = {
  root: "group relative mb-12 scroll-mt-[var(--reader-anchor-offset)] text-center",
  citation: "mb-4 text-[1.55rem] leading-tight font-bold",
  instrument: "text-[1.35rem] leading-tight font-bold tracking-wide",
  issuer: "mt-2 text-[1.25rem] leading-snug font-semibold",
  date: "mt-3 text-[1.05rem] leading-relaxed",
  title: "mt-2 text-[1.15rem] leading-relaxed font-semibold text-balance",
} as const;

/** The statute's reading column, around its masthead and its blocks. */
export const STATUTE_TEXT_CLASS_NAME =
  "reader-statute text-card-foreground text-start";

/**
 * The masthead before the act is read: the citation, the instrument and the
 * title, each a bar on its own line at its own size. Issuer and date lines
 * are left out: not every act states them, and a bar would claim one.
 */
const StatuteMastheadPending = () => (
  <header className={STATUTE_MASTHEAD_CLASS_NAMES.root}>
    <div className={STATUTE_MASTHEAD_CLASS_NAMES.citation}>
      <FaceLabelPending className="w-40" />
    </div>
    <div className={STATUTE_MASTHEAD_CLASS_NAMES.instrument}>
      <FaceLabelPending className="w-24" />
    </div>
    <div className={STATUTE_MASTHEAD_CLASS_NAMES.title}>
      <FaceLabelPending className="w-72" />
    </div>
  </header>
);

/** `StatuteText` before its act arrives: the masthead, then paragraphs. */
export const StatuteTextPending = () => (
  <div className={STATUTE_TEXT_CLASS_NAME} style={READER_BODY_STYLE}>
    <StatuteMastheadPending />
    <ReaderParagraphsPending />
  </div>
);
