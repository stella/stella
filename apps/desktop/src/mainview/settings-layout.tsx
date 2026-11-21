import type { ReactNode } from "react";

/**
 * A Settings page's header. The page under it is composed from
 * `@stll/ui/settings`: sections of rows on one surface each.
 */

/** The page's title, one quiet line under it, and an optional control that
 *  governs the whole page (such as the switch that turns a feature on). */
export const SettingsPageHeader = ({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description?: ReactNode;
  title: string;
}) => (
  <header className="flex items-start gap-4">
    <div className="min-w-0 flex-1">
      <h1 className="text-xl font-semibold text-balance">{title}</h1>
      {description === undefined ? null : (
        <p className="text-muted-foreground mt-1 text-sm text-pretty">
          {description}
        </p>
      )}
    </div>
    {action === undefined ? null : (
      <div className="mt-1 shrink-0">{action}</div>
    )}
  </header>
);
