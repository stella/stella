import type { ReactNode } from "react";

import {
  OUTCOME_TILE_CLASS,
  OutcomeContent,
  OutcomePage,
  OutcomeStatusBadge,
  OutcomeTitle,
  StellaOutcomeTile,
} from "./outcome-screen-core";
import type { OutcomeContentProps, OutcomeTone } from "./outcome-screen-core";

// The outcome screen's markup, with no browser behaviour: `OutcomeScreen`
// (./outcome-screen.tsx) adds closing the tab, and this package's
// `scripts/generate-outcome-page.ts` renders this view into the template the
// loopback listeners serve, where no script runs. The generator renders
// `OutcomeLayout` with slots where the optional parts go, and each optional
// part (`OutcomeDetailList`, `OutcomeDetailRow`, `OutcomeCommand`,
// `OutcomeNote`) on its own,
// so a listener fills in exactly the markup this module draws.

export type { OutcomeTone } from "./outcome-screen-core";

/** One fact about what the flow connected, e.g. Account: jan@firm.example. */
export type OutcomeDetail = {
  /** What the fact is, in a word or two. */
  label: string;
  /** The fact itself; isolated as its own bidi run (names, emails). */
  value: ReactNode;
};

type OutcomeLayoutProps = OutcomeContentProps & {
  /** The other side's identity (a logo), drawn in a tile beside stella's. */
  counterpart?: ReactNode;
  /** The flow's facts, drawn by `OutcomeDetailList`. */
  details?: ReactNode;
  /** A command to run next, drawn by `OutcomeCommand`. */
  command?: ReactNode;
  /** A quiet footnote, drawn by `OutcomeNote`. */
  note?: ReactNode;
  /** A page owns the viewport, or is embedded in a frame that already owns it. */
  surface?: "page" | "embedded";
};

export type OutcomeScreenViewProps = Omit<
  OutcomeLayoutProps,
  "details" | "command" | "note" | "title"
> & {
  /** What happened. Also the document title when none is supplied. */
  title: string;
  /**
   * What the flow connected, 1 to 3 facts it already holds (the account, the
   * organization, the access granted). Leave it out when there is nothing
   * specific to say; never fill it with generic text.
   */
  details?: readonly OutcomeDetail[];
  /** A command the person runs next, e.g. to try again from a terminal. */
  command?: string;
  /**
   * That the tab can be closed, and only when it really can: never beside a
   * redirect or a button, which are the way on themselves.
   */
  note?: ReactNode;
};

const PairedOutcomeGlyph = ({
  counterpart,
  tone,
}: {
  counterpart: ReactNode;
  tone: OutcomeTone;
}) => (
  <div className="flex items-center" aria-hidden="true">
    <span className={OUTCOME_TILE_CLASS} data-slot="outcome-tile">
      {counterpart}
    </span>
    <span className="relative flex w-16 items-center justify-center">
      <span
        className="bg-border motion-safe:animate-outcome-connector h-px w-full"
        data-slot="outcome-connector"
      />
      <OutcomeStatusBadge className="absolute" tone={tone} />
    </span>
    <StellaOutcomeTile />
  </div>
);

/** The facts' one quiet surface; its rows are `OutcomeDetailRow`s. */
// Two columns shared by every row: the labels' column is as wide as the
// widest label, and each value starts right after it.
export const OutcomeDetailList = ({ children }: { children: ReactNode }) => (
  <dl
    className="bg-muted mt-6 grid w-full max-w-[22rem] grid-cols-[max-content_minmax(0,1fr)] gap-x-4 rounded-xl px-4 py-2 text-start text-sm"
    data-slot="outcome-details"
  >
    {children}
  </dl>
);

/**
 * One fact: its label in the start column, the value (one bidi run) beside
 * it. A long value wraps rather than cut short, so an email reads in full.
 */
export const OutcomeDetailRow = ({
  label,
  value,
}: {
  label: ReactNode;
  value: ReactNode;
}) => (
  <div
    className="col-span-2 grid grid-cols-subgrid py-1.5"
    data-slot="outcome-detail"
  >
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="text-foreground min-w-0 wrap-break-word">
      <bdi>{value}</bdi>
    </dd>
  </div>
);

/**
 * A place or control in the app, named as it reads there ("General"), set
 * apart inside running text so the way back can be scanned.
 */
export const OutcomeControl = ({ children }: { children: ReactNode }) => (
  <bdi
    className="bg-muted text-foreground rounded-md px-1.5 py-0.5 font-medium whitespace-nowrap"
    data-slot="outcome-control"
  >
    {children}
  </bdi>
);

/** A button's label inside running text; the sentence supplies the quotes. */
export const OutcomeButtonLabel = ({ children }: { children: ReactNode }) => (
  <bdi className="text-foreground font-medium" data-slot="outcome-button-label">
    {children}
  </bdi>
);

/** A command to run, set as code: left to right in every language. */
export const OutcomeCommand = ({ children }: { children: ReactNode }) => (
  <code
    className="bg-muted text-foreground mt-5 max-w-full rounded-lg px-3 py-1.5 font-mono text-[0.8125rem] break-all select-all"
    data-slot="outcome-command"
    dir="ltr"
  >
    {children}
  </code>
);

/** The quiet line under everything else. */
export const OutcomeNote = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground mt-6 text-xs" data-slot="outcome-note">
    {children}
  </p>
);

/**
 * The screen with every optional part already drawn: `OutcomeScreenView`
 * draws them from props, the generator puts template slots in their place.
 */
export const OutcomeLayout = ({
  counterpart,
  details,
  command,
  note,
  surface = "page",
  ...layout
}: OutcomeLayoutProps) => {
  const content = {
    ...layout,
    glyph:
      counterpart === undefined || counterpart === null ? undefined : (
        <PairedOutcomeGlyph counterpart={counterpart} tone={layout.tone} />
      ),
    beforeActions: (
      <>
        {details}
        {command}
      </>
    ),
    afterActions: note,
  };
  if (surface === "embedded") {
    return (
      <div
        className="flex w-full justify-center py-10"
        data-slot="outcome-screen"
      >
        <OutcomeTitle {...layout} />
        <OutcomeContent {...content} />
      </div>
    );
  }
  return <OutcomePage {...content} />;
};

export const OutcomeScreenView = ({
  details,
  command,
  note,
  ...layout
}: OutcomeScreenViewProps) => (
  <OutcomeLayout
    {...layout}
    note={note === undefined ? undefined : <OutcomeNote>{note}</OutcomeNote>}
    command={
      command === undefined ? undefined : (
        <OutcomeCommand>{command}</OutcomeCommand>
      )
    }
    details={
      details === undefined || details.length === 0 ? undefined : (
        <OutcomeDetailList>
          {details.map(({ label, value }) => (
            <OutcomeDetailRow key={label} label={label} value={value} />
          ))}
        </OutcomeDetailList>
      )
    }
  />
);
