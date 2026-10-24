import type * as React from "react";

import { ReviewAuthorAvatar } from "@stll/ui/review-author-avatar";
import { cn } from "@stll/ui/utils";

import type { PreviewPerson } from "./mock-data";

/** Props every scene takes: its interface labels, the formatting locale for
 *  its dates and numbers, and classes for the host's sizing. */
export type FeaturePreviewProps<Labels> = {
  labels: Labels;
  /** Full formatting locale (`en-GB`, `cs-CZ`), used for dates and numbers. */
  locale: string;
  className?: string | undefined;
};

type FeaturePreviewSurfaceProps = React.PropsWithChildren<{
  icon: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  className?: string | undefined;
}>;

/**
 * The window every scene draws in: a title row and a clipped body that fills
 * whatever box the host gives it. Decorative, so it is hidden from assistive
 * technology and takes no pointer input; the host names what it illustrates.
 */
export const FeaturePreviewSurface = ({
  icon,
  title,
  meta,
  className,
  children,
}: FeaturePreviewSurfaceProps) => (
  <div
    aria-hidden
    className={cn(
      "bg-background text-foreground pointer-events-none flex size-full min-h-0 flex-col overflow-hidden rounded-lg border text-start text-xs select-none",
      className,
    )}
    data-slot="feature-preview"
  >
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      {icon}
      <span className="min-w-0 truncate text-sm font-medium">{title}</span>
      {meta === undefined ? null : (
        <span className="text-muted-foreground ms-auto flex shrink-0 items-center gap-2">
          {meta}
        </span>
      )}
    </div>
    <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
  </div>
);

/** A row of overlapping initials, as the app shows a matter's team. */
export const PreviewAvatarStack = ({
  people,
}: {
  people: readonly PreviewPerson[];
}) => (
  <span className="flex gap-1">
    {people.map((person) => (
      <PreviewAvatar key={person.name} person={person} />
    ))}
  </span>
);

export const PreviewAvatar = ({ person }: { person: PreviewPerson }) => (
  <ReviewAuthorAvatar className="size-5 shrink-0" name={person.name} />
);
