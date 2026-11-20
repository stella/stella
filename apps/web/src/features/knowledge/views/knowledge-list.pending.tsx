import type { ComponentType, ReactElement, ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

/*
 * The pieces the Knowledge lists share (clauses, workflows): a row's tile,
 * title and the line under it, placeholder rows of that shape, and a
 * toolbar action's face. Light presentational pieces only, so a section's
 * loading view draws them before any provider mounts.
 */

/** A list row's body: the section's tile, the title and the line under it,
 *  then what the row ends with. */
export const KnowledgeRowBody = ({
  className,
  icon: Icon,
  meta,
  metaClassName,
  title,
  trailing,
}: {
  className?: string | undefined;
  icon: ComponentType<{ className?: string }>;
  meta: ReactNode;
  metaClassName?: string | undefined;
  title: ReactNode;
  trailing?: ReactNode;
}) => (
  <span className={cn("flex min-w-0 flex-1 items-center gap-3", className)}>
    <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
      <Icon className="text-muted-foreground size-4" />
    </span>
    <span className="flex min-w-0 flex-1 flex-col">
      {title}
      <span className={cn("text-muted-foreground text-xs", metaClassName)}>
        {meta}
      </span>
    </span>
    {trailing}
  </span>
);

const TITLE_WIDTHS = ["w-48", "w-40", "w-56", "w-36", "w-44"];

/** A placeholder row's title: a bar on the `text-sm` title's line. */
export const RowTitlePending = ({ index }: { index: number }) => (
  <span className="text-sm">
    <FaceLabelPending
      className={cn(TITLE_WIDTHS[index % TITLE_WIDTHS.length])}
    />
  </span>
);

/** `count` placeholder rows, each drawn by `row` (with its index). */
export const KnowledgeRowsPending = ({
  count,
  row,
}: {
  count: number;
  row: (index: number) => ReactElement;
}) => (
  <ul
    aria-hidden="true"
    className="divide-y"
    data-slot="knowledge-rows-pending"
  >
    {Array.from({ length: count }, (_, index) => row(index))}
  </ul>
);

/** A small toolbar action's face: its icon, and its label from `sm` up when
 *  the button shows it only there. */
export const ActionFace = ({
  icon,
  label,
  labelFromSm = false,
  variant,
  width,
}: {
  icon: ReactNode;
  label: PendingTextKey;
  labelFromSm?: boolean | undefined;
  variant: "default" | "outline" | "ghost";
  /** The bar's width, roughly the label's. */
  width: string;
}) => {
  const text = <PendingText barClassName={width} id={label} />;
  return (
    <ButtonFace size="sm" variant={variant}>
      {icon}
      {labelFromSm ? <span className="hidden sm:inline">{text}</span> : text}
    </ButtonFace>
  );
};
