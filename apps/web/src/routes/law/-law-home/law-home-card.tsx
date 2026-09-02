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
};

/**
 * One card of the law home: a kind and a handful of rows, grouped where the
 * kind has several subjects. A card with nothing to show is not rendered at
 * all, so the grid never carries a placeholder.
 */
export const LawHomeCard = ({
  children,
  heading,
  showAll,
}: LawHomeCardProps) => (
  <section className="border-border/60 flex min-w-0 flex-col gap-4 rounded-lg border p-4">
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {heading}
      </h2>
      {showAll}
    </div>
    {children}
  </section>
);

type LawHomeCardGroupProps = {
  children: ReactNode;
  /** A muted qualifier for the title, e.g. a court's rank. */
  tag?: string | null | undefined;
  /** The subject of these rows: a court, a side of a shelf. */
  title: ReactNode;
};

/** One subject inside a card: its name, its rank, its rows. */
export const LawHomeCardGroup = ({
  children,
  tag,
  title,
}: LawHomeCardGroupProps) => (
  <section className="flex min-w-0 flex-col gap-2">
    <div className="flex min-w-0 items-baseline gap-2">
      <h3 className="text-foreground min-w-0 truncate text-sm font-medium">
        {title}
      </h3>
      {tag !== null && tag !== undefined && (
        <span className="text-muted-foreground bg-muted/60 shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem]">
          {tag}
        </span>
      )}
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
