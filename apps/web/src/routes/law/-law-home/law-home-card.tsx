import type { ReactNode } from "react";

/** The "show all" affordance every card carries in the same place. */
export const LAW_HOME_SHOW_ALL_CLASS =
  "text-muted-foreground hover:text-foreground shrink-0 text-xs transition-colors";

type LawHomeCardProps = {
  children: ReactNode;
  /** What kind of card this is, as a small uppercase label. */
  heading: string;
  /** The link out to the full list, when the card is a sample of one. */
  showAll?: ReactNode;
  /** A muted qualifier for the title, e.g. a court's rank. */
  tag?: string | null | undefined;
  /** What the card is about, when the heading does not already name it. */
  title?: string | undefined;
};

/**
 * One card of the law home: a kind, an optional subject, a handful of rows.
 * A card with nothing to show is not rendered at all, so the grid never
 * carries a placeholder.
 */
export const LawHomeCard = ({
  children,
  heading,
  showAll,
  tag,
  title,
}: LawHomeCardProps) => (
  <section className="border-border/60 flex min-w-0 flex-col gap-3 rounded-lg border p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {heading}
        </h2>
        {title !== undefined && (
          <div className="mt-1 flex min-w-0 items-baseline gap-2">
            <p className="text-foreground min-w-0 truncate text-sm font-medium">
              {title}
            </p>
            {tag !== null && tag !== undefined && (
              <span className="text-muted-foreground bg-muted/60 shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem]">
                {tag}
              </span>
            )}
          </div>
        )}
      </div>
      {showAll}
    </div>
    {children}
  </section>
);

type LawHomeRowProps = {
  /** The one line under the identifier: a headnote, a validity date. */
  line?: string | null | undefined;
  /** A short value on the identifier's line, e.g. the decision date. */
  meta?: string | null | undefined;
  /** The identifier itself, as a link to what it names. */
  title: ReactNode;
};

export const LawHomeRow = ({ line, meta, title }: LawHomeRowProps) => (
  <li className="min-w-0">
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <div className="min-w-0 truncate text-sm">{title}</div>
      {Boolean(meta) && (
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {meta}
        </span>
      )}
    </div>
    {Boolean(line) && (
      <p className="text-muted-foreground mt-0.5 truncate text-xs">{line}</p>
    )}
  </li>
);

export const LawHomeRowList = ({ children }: { children: ReactNode }) => (
  <ul className="flex flex-col gap-2">{children}</ul>
);
