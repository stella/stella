import type { ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

/**
 * The guidance reader's one layout, drawn by both phases: the notice that
 * this is not a court decision over the document's header, its text and its
 * source footer. The page fills the slots with the document; the pending
 * phase with lines of the same type size.
 */
export const GuidanceReaderShell = ({
  header,
  body,
  footer,
}: {
  header: ReactNode;
  body: ReactNode;
  footer: ReactNode;
}) => (
  <article className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8">
    <p className="text-muted-foreground text-sm">
      <PendingText barClassName="w-80" id="guidance.notCaseLaw" />
    </p>
    <header className="flex flex-col gap-1">{header}</header>
    {body}
    <footer className="text-muted-foreground flex flex-col gap-1 border-t pt-4 text-xs">
      {footer}
    </footer>
  </article>
);

/** Placeholder paragraphs while the text loads, about a screen of them. */
const GUIDANCE_PARAGRAPH_LINES_PENDING = [
  { key: "a", width: "w-full" },
  { key: "b", width: "w-11/12" },
  { key: "c", width: "w-full" },
  { key: "d", width: "w-3/4" },
] as const;

/** The issuer line, the title and the reference, at the header's type sizes. */
const GuidanceHeaderPending = () => (
  <>
    <p className="text-sm">
      <FaceLabelPending className="w-48" />
    </p>
    <h1 className="text-xl font-semibold">
      <FaceLabelPending className="w-3/4" />
    </h1>
    <p className="text-sm">
      <FaceLabelPending className="w-32" />
    </p>
  </>
);

/** The text's lines at the body's type size and spacing. */
const GuidanceTextPending = () => (
  <div
    aria-hidden="true"
    className="flex flex-col gap-3 text-sm leading-relaxed"
  >
    {GUIDANCE_PARAGRAPH_LINES_PENDING.map((line) => (
      <p className="flex" key={line.key}>
        <FaceLabelPending className={line.width} />
      </p>
    ))}
  </div>
);

const GuidanceReaderPendingView = () => (
  <GuidanceReaderShell
    header={<GuidanceHeaderPending />}
    body={<GuidanceTextPending />}
    footer={
      <p>
        <FaceLabelPending className="w-56" />
      </p>
    }
  />
);

export const GuidanceReaderPending = framePendingView(
  GuidanceReaderPendingView,
);
