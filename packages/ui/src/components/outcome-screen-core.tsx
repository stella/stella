import type { ReactNode, Ref } from "react";

import { CheckIcon, XIcon } from "../icons";
import { cn } from "../lib/utils";
import { StellaMark } from "./stella-mark";

export type OutcomeTone = "success" | "error";

export type OutcomeContentProps = {
  tone: OutcomeTone;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  documentTitle?: string;
  headingRef?: Ref<HTMLHeadingElement>;
};

type OutcomeCoreProps = OutcomeContentProps & {
  glyph?: ReactNode;
  beforeActions?: ReactNode;
  afterActions?: ReactNode;
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
export const OUTCOME_TILE_CLASS =
  "bg-card text-foreground shadow-outcome-tile relative flex size-14 shrink-0 items-center justify-center rounded-2xl";

export const OutcomeStatusBadge = ({
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

export const StellaOutcomeTile = () => (
  <span className={OUTCOME_TILE_CLASS} data-slot="outcome-tile">
    <StellaMark className="size-7" />
  </span>
);

const OutcomeGlyph = ({ tone }: { tone: OutcomeTone }) => (
  <div className="relative" aria-hidden="true">
    <StellaOutcomeTile />
    <OutcomeStatusBadge
      className="absolute -end-1.25 -bottom-1.25"
      tone={tone}
    />
  </div>
);

export const OutcomeTitle = ({
  documentTitle,
  title,
}: Pick<OutcomeContentProps, "documentTitle" | "title">) => {
  const text = documentTitle ?? (typeof title === "string" ? title : undefined);
  return text === undefined ? null : <title>{text}</title>;
};

export const OutcomeContent = ({
  tone,
  title,
  description,
  actions,
  headingRef,
  glyph,
  beforeActions,
  afterActions,
}: OutcomeCoreProps) => (
  <section
    className="motion-safe:animate-rise flex w-full max-w-[26rem] flex-col items-center text-center wrap-anywhere"
    data-slot="outcome"
    data-tone={tone}
    role="status"
  >
    {glyph ?? <OutcomeGlyph tone={tone} />}
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
    {beforeActions}
    {actions === undefined ? null : (
      <div className="mt-7 flex flex-wrap justify-center gap-2">{actions}</div>
    )}
    {afterActions}
  </section>
);

export const OutcomePage = (props: OutcomeCoreProps) => (
  <main
    className="bg-background text-foreground flex min-h-dvh w-full flex-col items-center justify-center px-4 pt-12 pb-[14svh] font-sans"
    data-slot="outcome-screen"
  >
    <OutcomeTitle {...props} />
    <OutcomeContent {...props} />
  </main>
);
