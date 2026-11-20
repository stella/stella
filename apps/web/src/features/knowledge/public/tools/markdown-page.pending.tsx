import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { XIcon } from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";
import {
  ToolDetailPanelFrame,
  ToolDetailSection,
} from "@/features/knowledge/views/tools/tool-detail-panel.pending";

// A published tool's documentation page in both phases (a pending-safe
// module): `ToolMarkdown` renders the documentation's frame with the
// markdown, and the pending views draw it with placeholder lines.

/** The documentation's section: its heading row, then the rendered card. */
export const MarkdownSectionFrame = ({
  label,
  heading,
  action,
  children,
}: {
  /** The section's accessible name, when the heading is real text. */
  label?: string | undefined;
  heading: ReactNode;
  action: ReactNode;
  children: ReactNode;
}) => (
  <section aria-label={label} className="flex flex-col gap-2">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{heading}</h2>
      {action}
    </div>
    <div className="border-border bg-card rounded-md border p-4">
      {children}
    </div>
  </section>
);

// One width per placeholder line, which also keys it.
const BODY_LINE_WIDTHS = ["w-2/5", "w-full", "w-11/12", "w-5/6", "w-3/5"];

/**
 * The documentation before it is rendered. It fills the screen, so what
 * follows it stays out of view until the text arrives rather than jumping
 * away then.
 */
export const MarkdownSectionPending = () => (
  <MarkdownSectionFrame
    action={
      <ButtonFace size="xs" variant="outline">
        <PendingText barClassName="w-8" id="common.copy" />
      </ButtonFace>
    }
    heading={<PendingText barClassName="w-24" id="publicTools.content" />}
  >
    <div aria-hidden="true" className="flex min-h-dvh flex-col gap-2 text-sm">
      {BODY_LINE_WIDTHS.map((width) => (
        <FaceLabelPending className={width} key={width} />
      ))}
    </div>
  </MarkdownSectionFrame>
);

/**
 * A published tool's page before its entry has been read: the title bar,
 * the summary and the documentation, each holding its place, and the
 * install action's bar.
 */
export const MarkdownPagePending = () => (
  <ToolDetailPanelFrame
    body={
      <>
        <ToolDetailSection
          title={
            <PendingText
              barClassName="w-12"
              id="onboarding.catalogueDetailAbout"
            />
          }
        >
          <p className="text-sm leading-relaxed">
            <FaceLabelPending className="w-full" />
            <FaceLabelPending className="w-2/3" />
          </p>
        </ToolDetailSection>
        <MarkdownSectionPending />
      </>
    }
    bodyClassName="overflow-hidden"
    footer={
      <ButtonFace size="default" variant="default">
        <PendingText barClassName="w-24" id="publicTools.addToStella" />
      </ButtonFace>
    }
    header={
      <>
        <h2 className="min-w-0 text-sm font-semibold">
          <FaceLabelPending className="w-40" />
        </h2>
        <ButtonFace className="ms-auto shrink-0" size="icon-xs" variant="ghost">
          <XIcon className="size-3.5" />
        </ButtonFace>
      </>
    }
  />
);
