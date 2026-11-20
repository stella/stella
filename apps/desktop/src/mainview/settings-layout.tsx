import type { ReactNode } from "react";

import {
  List,
  ListGroup,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemTitle,
} from "@stll/ui/list";
import { cn } from "@stll/ui/utils";

/**
 * The building blocks every Settings page is drawn with: a page header, and
 * groups of hairline-divided rows on one surface (`@stll/ui/list`). A row is
 * a title, one quiet line and its trailing control; the control names itself
 * through the row's ids (`settingsRowIds`).
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

/** A titled group: one surface of rows (`li`). */
export const SettingsGroup = ({
  children,
  title,
}: React.PropsWithChildren<{ title?: string | undefined }>) => (
  <ListGroup>
    {title ? (
      <ListGroupHeader>
        <ListGroupHeading>
          <ListGroupTitle>{title}</ListGroupTitle>
        </ListGroupHeading>
      </ListGroupHeader>
    ) : null}
    <List>{children}</List>
  </ListGroup>
);

/** A group that holds a section drawn by its own component, which lays out
 *  its own rows inside the surface. */
export const SettingsSectionGroup = ({
  children,
  title,
}: React.PropsWithChildren<{ title?: string | undefined }>) => (
  <SettingsGroup title={title}>
    <li className="block min-w-0">{children}</li>
  </SettingsGroup>
);

/** The ids a row's control points at for its name and description. */
export const settingsRowIds = (id: string) => ({
  description: `${id}-description`,
  label: `${id}-label`,
});

/** How far a row sits in: `nested` rows refine the row above them. */
type SettingsRowDepth = "top" | "nested";

const ROW_DEPTH_CLASS = {
  nested: "ps-10",
  top: "ps-4",
} as const satisfies Record<SettingsRowDepth, string>;

type SettingsRowProps = {
  /** The trailing status, value or control. */
  children?: ReactNode;
  depth?: SettingsRowDepth;
  description?: ReactNode;
  /** Shown dimmed: its control is disabled until the row above allows it. */
  disabled?: boolean;
  /** Under the row and inside it, without a divider: a warning or an error
   *  about this row's value. */
  footer?: ReactNode;
  id: string;
  /** A 32px tile before the title (`ListItemMedia`). */
  media?: ReactNode;
  title: ReactNode;
};

/** One settings row: media, title and description, then the control. */
export const SettingsRow = ({
  children,
  depth = "top",
  description,
  disabled = false,
  footer,
  id,
  media,
  title,
}: SettingsRowProps) => {
  const ids = settingsRowIds(id);
  return (
    <li
      className="flex min-w-0 flex-col"
      data-disabled={disabled ? "" : undefined}
      data-slot="settings-row"
    >
      <div
        className={cn(
          // A row too narrow for its text and its control wraps the control
          // under the text rather than squeezing the text.
          "flex min-h-14 w-full flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pe-4 text-start",
          ROW_DEPTH_CLASS[depth],
        )}
      >
        {media}
        <ListItemContent
          className={cn("min-w-48 basis-48", disabled && "opacity-64")}
        >
          <ListItemTitle id={ids.label} variant="statement">
            {title}
          </ListItemTitle>
          {description === undefined || description === null ? null : (
            <ListItemDescription
              id={ids.description}
              lines="none"
              variant="paragraph"
            >
              {description}
            </ListItemDescription>
          )}
        </ListItemContent>
        {children === undefined ? null : (
          <ListItemActions className="ms-auto">{children}</ListItemActions>
        )}
      </div>
      {footer === undefined || footer === null ? null : (
        <div className={cn("pe-4 pb-3", ROW_DEPTH_CLASS[depth])}>{footer}</div>
      )}
    </li>
  );
};
