import type { ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

/*
 * A detail page's description-list sections (a contact's identity, billing,
 * owners): a bordered card with its heading over label and value rows. The
 * loaded page draws its sections from `DetailSection` and `DetailRow`, and
 * its loading view draws `DetailSectionSkeleton` from the same two, so a
 * section that replaces its skeleton lands in the same box.
 */

/** A titled section of a detail page: the card and its heading. */
export const DetailSection = ({
  children,
  className,
  notice,
  title,
}: {
  children: ReactNode;
  className?: string | undefined;
  /** Above the heading: a read's failure, which pushes the section down. */
  notice?: ReactNode;
  title: ReactNode;
}) => (
  <section className={cn("rounded-lg border p-4", className)}>
    {notice}
    <h2 className="text-muted-foreground mb-3 text-sm font-medium">{title}</h2>
    {children}
  </section>
);

/** A section's rows, one rhythm for every row inside. */
export const DetailRows = ({
  children,
  className = "space-y-2",
}: {
  children: ReactNode;
  /** The gap between rows: a row of pickers sits looser. */
  className?: string | undefined;
}) => <div className={cn("text-sm", className)}>{children}</div>;

/** The label column every row of a detail section shares. */
export const DETAIL_ROW_LABEL_CLASS = "text-muted-foreground w-32 shrink-0";

/** One label and its value, on a line. */
export const DetailRow = ({
  align = "baseline",
  children,
  label,
}: {
  /** `center` for a value drawn in a control (a picker, a select). */
  align?: "baseline" | "center" | undefined;
  children: ReactNode;
  label: ReactNode;
}) => (
  <div
    className={cn(
      "flex gap-2",
      align === "center" ? "items-center" : "items-baseline",
    )}
  >
    <span className={DETAIL_ROW_LABEL_CLASS}>{label}</span>
    {children}
  </div>
);

/** A row of a section before its data: its label's words, or `null` for a
 *  label the data names (a custom field, an email's kind). */
type DetailRowSkeleton = { key: string; label: PendingTextKey | null };

/** Skeleton rows for labels the page always shows, in its order. */
export const labelledDetailRows = (
  labels: readonly PendingTextKey[],
): readonly DetailRowSkeleton[] =>
  labels.map((label) => ({ key: label, label }));

const UNNAMED_ROW_KEYS: readonly string[] = ["a", "b", "c", "d", "e", "f"];

/** Skeleton rows for a section whose rows the data names. */
export const unnamedDetailRows = (
  count: number,
): readonly DetailRowSkeleton[] =>
  UNNAMED_ROW_KEYS.slice(0, count).map((key) => ({ key, label: null }));

/**
 * A detail section before its data: the heading (its words when they are
 * static, else a bar) and one row per label, with a bar where each value
 * goes.
 */
export const DetailSectionSkeleton = ({
  className,
  rows,
  title,
}: {
  className?: string | undefined;
  rows: readonly DetailRowSkeleton[];
  title: PendingTextKey | null;
}) => (
  <DetailSection
    className={className}
    title={
      title === null ? (
        <FaceLabelPending className="w-28" />
      ) : (
        <PendingText barClassName="w-28" id={title} />
      )
    }
  >
    <DetailRows>
      {rows.map((row) => (
        <DetailRow
          key={row.key}
          label={
            row.label === null ? (
              <FaceLabelPending className="w-20" />
            ) : (
              <PendingText barClassName="w-20" id={row.label} />
            )
          }
        >
          <FaceLabelPending className="w-32" />
        </DetailRow>
      ))}
    </DetailRows>
  </DetailSection>
);
