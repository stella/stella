import type { CSSProperties, ReactNode, Ref } from "react";

import { FileSpreadsheetIcon, UploadIcon } from "@stll/ui/icons";
import { Step, Steps } from "@stll/ui/steps";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The studio's steps, in their order. */
const IMPORT_STEP_KEYS: readonly PendingTextKey[] = [
  "contacts.importStudio.stepUpload",
  "contacts.importStudio.stepMap",
  "knowledge.playbooks.review.run",
  "common.done",
];

type ImportStepStatus = "completed" | "current" | "upcoming";

const stepStatus = (index: number, current: number): ImportStepStatus => {
  if (index === current) {
    return "current";
  }
  return index < current ? "completed" : "upcoming";
};

/**
 * The studio's progress: every step in its order, the one it is on marked
 * current and the ones before it done.
 */
export const ImportSteps = ({
  current,
  label,
  lang,
  markerStyle,
}: {
  current: number;
  label?: string | undefined;
  lang?: string | undefined;
  markerStyle: NonNullable<CSSProperties["listStyleType"]>;
}) => (
  <Steps
    aria-label={label}
    lang={lang}
    markerStyle={markerStyle}
    variant="progress"
  >
    {IMPORT_STEP_KEYS.map((key, index) => (
      <Step
        aria-current={index === current ? "step" : undefined}
        key={key}
        status={stepStatus(index, current)}
      >
        <PendingText barClassName="w-16" id={key} />
      </Step>
    ))}
  </Steps>
);

/**
 * The import studio's frame: its heading and progress over the step it is
 * on, and under that the step's footer once it has one. The upload step
 * fills the main area, so the whole screen takes a dropped file.
 */
export const ContactImportShell = ({
  busy = false,
  children,
  footer,
  steps,
  upload,
}: {
  busy?: boolean | undefined;
  children: ReactNode;
  footer?: ReactNode;
  steps: ReactNode;
  upload: boolean;
}) => (
  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <header className="border-b px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold">
            <PendingText barClassName="w-40" id="contacts.importStudio.title" />
          </h1>
          <p className="text-muted-foreground text-sm">
            <PendingText
              barClassName="w-72"
              id="contacts.importStudio.description"
            />
          </p>
        </div>
        {steps}
      </div>
    </header>
    <main
      aria-busy={busy}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6",
        upload && "flex flex-col p-4 sm:p-6",
      )}
    >
      {children}
    </main>
    {footer}
  </div>
);

/** The upload step's frame: the drop target that fills the main area. */
export const UploadStepFrame = ({
  children,
  heading,
  ref,
}: {
  children: ReactNode;
  heading: ReactNode;
  ref?: Ref<HTMLElement> | undefined;
}) => (
  <section className="flex min-h-0 flex-1 flex-col" ref={ref}>
    {heading}
    {children}
  </section>
);

/**
 * The drop surface's content: the file glyph (or the loader in its place
 * while a file is read), what to drop, the files it takes and the picker's
 * words.
 */
export const UploadDropSurface = ({
  className,
  glyph,
}: {
  className?: string | undefined;
  /** In the file glyph's place: the loader while a file is read. */
  glyph?: ReactNode;
}) => (
  <span
    className={cn(
      "flex min-h-72 w-full flex-1 flex-col items-center justify-center gap-3 rounded-xl p-8 text-center",
      className,
    )}
  >
    {glyph ?? <FileSpreadsheetIcon className="text-muted-foreground size-10" />}
    <span className="font-medium">
      <PendingText barClassName="w-48" id="contacts.importStudio.dropFile" />
    </span>
    <span className="text-muted-foreground text-sm">
      <PendingText
        barClassName="w-40"
        id="contacts.importStudio.supportedFiles"
      />
    </span>
    <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
      <UploadIcon className="size-4" />
      <PendingText barClassName="w-20" id="common.chooseFile" />
    </span>
  </span>
);

/**
 * The import studio before its code has loaded: the heading, the progress on
 * its first step and the drop surface, as the studio opens. The studio reads
 * nothing before a file is chosen, so this is its first screen as it will be.
 */
const ContactImportPendingView = () => (
  <ContactImportShell
    steps={<ImportSteps current={0} markerStyle="decimal" />}
    upload
  >
    <UploadStepFrame heading={null}>
      {/* The upload button's box: it stretches with the step. */}
      <span className="flex w-full flex-1 items-stretch">
        <UploadDropSurface />
      </span>
    </UploadStepFrame>
  </ContactImportShell>
);

export const ContactImportPending = framePendingView(ContactImportPendingView);
