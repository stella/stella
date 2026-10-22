import type { ReactNode } from "react";

type FeatureRowProps = {
  badge?: string;
  description: string;
  icon: ReactNode;
  title: string;
};

/** One thing the app does: an icon, a name, and a sentence about it. */
export const FeatureRow = ({
  badge,
  description,
  icon,
  title,
}: FeatureRowProps) => (
  <div className="flex items-start gap-3 px-4 py-3">
    <div
      aria-hidden="true"
      className="bg-muted text-foreground grid size-8 shrink-0 place-items-center rounded-lg"
    >
      {icon}
    </div>
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {title}
        {badge ? (
          <span className="bg-success/12 text-success-foreground text-2xs rounded-full px-2 py-0.5 font-medium">
            {badge}
          </span>
        ) : null}
      </p>
      <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
        {description}
      </p>
    </div>
  </div>
);
