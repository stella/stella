import type { ReactNode } from "react";

import { CheckIcon, XIcon } from "../icons";
import { cn } from "../lib/utils";
import { StellaMark } from "./stella-mark";
import { StellaWordmarkLatin } from "./stella-wordmark";

// The outcome screen's markup, with no browser behaviour: `OutcomeScreen`
// (./outcome-screen.tsx) adds closing the tab, and this package's
// `scripts/generate-outcome-page.ts` renders this view into the template the
// loopback listeners serve, where no script runs.

export type OutcomeTone = "success" | "error";

export type OutcomeScreenViewProps = {
  tone: OutcomeTone;
  /** What happened, in a few words. Also the document title. */
  title: string;
  /** What to do next. */
  description?: ReactNode;
  /** The other side's identity (a logo), drawn in a tile beside stella's. */
  counterpart?: ReactNode;
  /** The way on, as buttons or links. */
  actions?: ReactNode;
  /** A quiet footnote, e.g. that the tab can be closed. */
  note?: ReactNode;
  /**
   * `page` owns the viewport and signs it with the wordmark; `embedded` sits
   * inside a layout that already brands the page (the sign-in layout).
   */
  surface?: "page" | "embedded";
  /** The document title, when it differs from `title` (an app suffix). */
  documentTitle?: string;
  /** The wordmark at the foot of a page; defaults to the Latin lockup. */
  wordmark?: ReactNode;
};

const TONE_BADGE = {
  success: { className: "bg-success", Icon: CheckIcon },
  error: { className: "bg-destructive", Icon: XIcon },
} as const satisfies Record<
  OutcomeTone,
  { className: string; Icon: typeof CheckIcon }
>;

const TILE_CLASS =
  "bg-card text-foreground outline-foreground/8 relative flex size-14 shrink-0 items-center justify-center rounded-2xl shadow-xs outline-1";

const StatusBadge = ({
  className,
  tone,
}: {
  className?: string;
  tone: OutcomeTone;
}) => {
  const { className: toneClass, Icon } = TONE_BADGE[tone];
  return (
    <span
      className={cn(
        "text-background ring-background motion-safe:animate-outcome-badge flex size-5 items-center justify-center rounded-full ring-2",
        toneClass,
        className,
      )}
      data-slot="outcome-badge"
      data-tone={tone}
    >
      <Icon className="size-3" strokeWidth={3} />
    </span>
  );
};

const OutcomeGlyph = ({
  counterpart,
  tone,
}: {
  counterpart: ReactNode;
  tone: OutcomeTone;
}) => {
  const stellaTile = (
    <span className={TILE_CLASS} data-slot="outcome-tile">
      <StellaMark className="size-7" />
    </span>
  );
  if (counterpart === undefined || counterpart === null) {
    return (
      <div className="relative" aria-hidden="true">
        {stellaTile}
        <StatusBadge className="absolute -end-1.5 -bottom-1.5" tone={tone} />
      </div>
    );
  }
  return (
    <div className="flex items-center" aria-hidden="true">
      <span className={TILE_CLASS} data-slot="outcome-tile">
        {counterpart}
      </span>
      <span className="relative flex w-16 items-center justify-center">
        <span
          className="bg-border motion-safe:animate-outcome-connector h-px w-full"
          data-slot="outcome-connector"
        />
        <StatusBadge className="absolute" tone={tone} />
      </span>
      {stellaTile}
    </div>
  );
};

export const OutcomeScreenView = ({
  tone,
  title,
  description,
  counterpart,
  actions,
  note,
  surface = "page",
  documentTitle,
  wordmark,
}: OutcomeScreenViewProps) => {
  const outcome = (
    <section
      className="flex w-full max-w-[26rem] flex-col items-center text-center"
      data-slot="outcome"
      data-tone={tone}
      role="status"
    >
      <OutcomeGlyph counterpart={counterpart} tone={tone} />
      <h1 className="mt-8 text-2xl font-semibold tracking-tight text-balance">
        {title}
      </h1>
      {description === undefined ? null : (
        <p className="text-muted-foreground mt-2 max-w-[22rem] text-sm text-pretty">
          {description}
        </p>
      )}
      {actions === undefined ? null : (
        <div className="mt-7 flex flex-wrap justify-center gap-2">
          {actions}
        </div>
      )}
      {note === undefined ? null : (
        <p className="text-muted-foreground mt-6 text-xs">{note}</p>
      )}
    </section>
  );
  const titleElement = <title>{documentTitle ?? title}</title>;
  if (surface === "embedded") {
    return (
      <div
        className="flex w-full justify-center py-10"
        data-slot="outcome-screen"
      >
        {titleElement}
        {outcome}
      </div>
    );
  }
  return (
    <main
      className="bg-background text-foreground flex min-h-dvh w-full flex-col px-4 font-sans"
      data-slot="outcome-screen"
    >
      {titleElement}
      {/* Optical centre: a little above the middle. */}
      <div className="flex flex-1 flex-col items-center justify-center pt-12 pb-[14svh]">
        {outcome}
      </div>
      <footer className="text-foreground-subtle flex justify-center pb-8">
        {wordmark ?? <StellaWordmarkLatin className="h-4 w-auto" />}
      </footer>
    </main>
  );
};
