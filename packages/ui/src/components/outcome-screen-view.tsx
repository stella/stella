import type { ReactNode, Ref } from "react";

import { CheckIcon, XIcon } from "../icons";
import { cn } from "../lib/utils";
import { StellaMark } from "./stella-mark";

// The outcome screen's markup, with no browser behaviour: `OutcomeScreen`
// (./outcome-screen.tsx) adds closing the tab, and this package's
// `scripts/generate-outcome-page.ts` renders this view into the template the
// loopback listeners serve, where no script runs. The generator renders
// `OutcomeLayout` with slots where the optional parts go, and each optional
// part (`OutcomeDetailList`, `OutcomeDetailRow`, `OutcomeCommand`,
// `OutcomeNote`) on its own,
// so a listener fills in exactly the markup this module draws.

export type OutcomeTone = "success" | "error";

/** One fact about what the flow connected, e.g. Account: jan@firm.example. */
export type OutcomeDetail = {
  /** What the fact is, in a word or two. */
  label: string;
  /** The fact itself; isolated as its own bidi run (names, emails). */
  value: ReactNode;
};

type OutcomeLayoutProps = {
  tone: OutcomeTone;
  /** What happened, in a few words. */
  title: ReactNode;
  /** What it means, or what to do next. */
  description?: ReactNode;
  /** The other side's identity (a logo), drawn in a tile beside stella's. */
  counterpart?: ReactNode;
  /** The flow's facts, drawn by `OutcomeDetailList`. */
  details?: ReactNode;
  /** A command to run next, drawn by `OutcomeCommand`. */
  command?: ReactNode;
  /** The way on, as buttons or links. */
  actions?: ReactNode;
  /** A quiet footnote, drawn by `OutcomeNote`. */
  note?: ReactNode;
  /**
   * `page` owns the viewport; `embedded` sits inside a layout that already
   * frames the page (the sign-in layout).
   */
  surface?: "page" | "embedded";
  /** The document title, when it differs from `title` (an app suffix). */
  documentTitle?: string;
  /** Makes the heading focusable and hands it over, to move focus to it. */
  headingRef?: Ref<HTMLHeadingElement>;
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

const TONE_BADGE = {
  success: { className: "bg-success", Icon: CheckIcon },
  error: { className: "bg-destructive", Icon: XIcon },
} as const satisfies Record<
  OutcomeTone,
  { className: string; Icon: typeof CheckIcon }
>;

// The tile's edge is a layered shadow, not a border. On a lone tile the badge
// is centred on the corner's curve (16px radius: 4.7px in from each edge), so
// its ring cuts the corner symmetrically.
const TILE_CLASS =
  "bg-card text-foreground shadow-outcome-tile relative flex size-14 shrink-0 items-center justify-center rounded-2xl";

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
        <StatusBadge className="absolute -end-1.25 -bottom-1.25" tone={tone} />
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
  tone,
  title,
  description,
  counterpart,
  details,
  command,
  actions,
  note,
  surface = "page",
  documentTitle,
  headingRef,
}: OutcomeLayoutProps) => {
  const outcome = (
    <section
      className="motion-safe:animate-rise flex w-full max-w-[26rem] flex-col items-center text-center wrap-anywhere"
      data-slot="outcome"
      data-tone={tone}
      role="status"
    >
      <OutcomeGlyph counterpart={counterpart} tone={tone} />
      <h1
        className="mt-7 text-2xl font-semibold tracking-tight text-balance outline-none"
        ref={headingRef}
        tabIndex={headingRef === undefined ? undefined : -1}
      >
        {title}
      </h1>
      {description === undefined ? null : (
        <p className="text-muted-foreground mt-2 max-w-[22rem] text-sm text-pretty">
          {description}
        </p>
      )}
      {details}
      {command}
      {actions === undefined ? null : (
        <div className="mt-7 flex flex-wrap justify-center gap-2">
          {actions}
        </div>
      )}
      {note}
    </section>
  );
  const titleText =
    documentTitle ?? (typeof title === "string" ? title : undefined);
  const titleElement =
    titleText === undefined ? null : <title>{titleText}</title>;
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
      className="bg-background text-foreground flex min-h-dvh w-full flex-col items-center justify-center px-4 pt-12 pb-[14svh] font-sans"
      data-slot="outcome-screen"
    >
      {titleElement}
      {/* Optical centre: a little above the middle. */}
      {outcome}
    </main>
  );
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
