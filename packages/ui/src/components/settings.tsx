"use client";

import { useId } from "react";
import type * as React from "react";

import { cn } from "../lib/utils";
import {
  List,
  ListGroup,
  ListGroupAction,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
} from "./list-shell";
import type { ListGroupTitleTone } from "./list-shell";

/*
 * The pieces every settings page is composed from, on the web and in the
 * desktop app: a section (a title, one quiet line, an optional trailing
 * action) over one surface of hairline-divided rows (`@stll/ui/list-shell`).
 * One option is one row: its title and one secondary line at the start, its
 * control at the end. A form, or anything else that is not a row, sits in a
 * `SettingsPanel` on the same surface. No Base UI and no popup, so a pending
 * view draws the same section and rows the page that loads does.
 */

type SettingsSectionProps = Omit<React.ComponentProps<"section">, "title"> & {
  /** The section's name; none when the page header already names it. */
  title?: React.ReactNode;
  /** One quiet line under the title. */
  description?: React.ReactNode;
  /** A quiet trailing action on the header row (an add or a link). */
  action?: React.ReactNode;
  /** `destructive` names an irreversible section (a danger zone). */
  tone?: ListGroupTitleTone | undefined;
  /** `SettingsRow`s and `SettingsPanel`s. */
  children: React.ReactNode;
};

// A slot filled with `condition && <X />` holds `false` when the condition
// fails; such a slot draws nothing and claims no header space.
const rendersSomething = (node: React.ReactNode): boolean =>
  node !== undefined && node !== null && node !== false;

/** A titled section over one surface of rows. */
const SettingsSection = ({
  action,
  children,
  description,
  title,
  tone,
  ...props
}: SettingsSectionProps) => {
  const titleId = useId();
  const named = rendersSomething(title);
  const described = rendersSomething(description);
  const acted = rendersSomething(action);
  return (
    <ListGroup aria-labelledby={named ? titleId : undefined} {...props}>
      {(named || described || acted) && (
        <ListGroupHeader>
          <ListGroupHeading>
            {named && (
              <ListGroupTitle id={titleId} tone={tone}>
                {title}
              </ListGroupTitle>
            )}
            {described && (
              <ListGroupDescription>{description}</ListGroupDescription>
            )}
          </ListGroupHeading>
          {acted && <ListGroupAction>{action}</ListGroupAction>}
        </ListGroupHeader>
      )}
      <List>{children}</List>
    </ListGroup>
  );
};

/**
 * A row's ids: the control points at `label` and `description` for its name
 * and its description, and takes `control` as its own id in a label row.
 */
const settingsRowIds = (id: string) => ({
  control: `${id}-control`,
  description: `${id}-description`,
  label: `${id}-label`,
});

/** How far a row sits in: a `nested` row refines the row above it. */
type SettingsRowDepth = "top" | "nested";

const ROW_DEPTH_CLASS = {
  nested: "ps-10",
  top: "ps-4",
} as const satisfies Record<SettingsRowDepth, string>;

/**
 * What a press on the row's text does. `label`: the text is the label of
 * the control whose id is `settingsRowIds(id).control` (a switch or a
 * checkbox), so a press on it flips the control. The text, not the whole
 * row, is the label: a label wrapped around the control would hand a press
 * on the control to it a second time where the label's default action runs
 * before the control's own handler cancels it.
 */
type SettingsRowInteraction =
  | { interaction?: "none" | undefined; id?: string | undefined }
  | { interaction: "label"; id: string };

// A row too narrow for its text and its control wraps the control under the
// text rather than squeezing the text.
const SETTINGS_ROW_BOX_CLASS =
  "flex min-h-14 w-full flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pe-4 text-start";

type SettingsRowProps = SettingsRowInteraction & {
  /** A 32px tile before the title (`ListItemMedia`). */
  media?: React.ReactNode;
  title: React.ReactNode;
  /** One secondary line under the title. */
  description?: React.ReactNode;
  /** The trailing control, value, status or link. */
  children?: React.ReactNode;
  /** Under the row and inside it, without a divider: a warning or an error
   *  about this row's value. */
  footer?: React.ReactNode;
  depth?: SettingsRowDepth | undefined;
  /** Shown dimmed: its control is disabled until something else allows it. */
  disabled?: boolean | undefined;
};

/** One option: media, title and secondary line, then its control. */
const SettingsRow = (props: SettingsRowProps) => {
  const {
    children,
    depth = "top",
    description,
    disabled = false,
    footer,
    id,
    media,
    title,
  } = props;
  const ids = id === undefined ? undefined : settingsRowIds(id);
  const controlId =
    props.interaction === "label" ? settingsRowIds(props.id).control : null;
  const text = (
    <>
      <span
        className="text-foreground text-sm font-medium text-pretty wrap-break-word"
        data-slot="settings-row-title"
        dir="auto"
        id={ids?.label}
      >
        {title}
      </span>
      {rendersSomething(description) && (
        <span
          className="text-muted-foreground text-xs text-pretty wrap-break-word"
          data-slot="settings-row-description"
          dir="auto"
          id={ids?.description}
        >
          {description}
        </span>
      )}
    </>
  );
  const textClass = cn(
    "flex min-w-48 flex-1 basis-48 flex-col justify-center gap-0.5 self-stretch",
    disabled && "opacity-64",
  );
  return (
    <li
      className="flex min-w-0 flex-col"
      data-disabled={disabled ? "" : undefined}
      data-slot="settings-row"
    >
      <div
        className={cn(
          SETTINGS_ROW_BOX_CLASS,
          ROW_DEPTH_CLASS[depth],
          controlId !== null &&
            "has-[label:hover]:bg-muted/50 has-data-disabled:has-[label:hover]:bg-transparent",
        )}
      >
        {media}
        {controlId === null ? (
          <span className={textClass}>{text}</span>
        ) : (
          <label
            className={cn(
              textClass,
              "cursor-pointer in-[li:has([data-disabled])]:cursor-not-allowed",
            )}
            htmlFor={controlId}
          >
            {text}
          </label>
        )}
        {rendersSomething(children) && (
          <span
            className="ms-auto flex shrink-0 items-center gap-2"
            data-slot="settings-row-control"
          >
            {children}
          </span>
        )}
      </div>
      {rendersSomething(footer) && (
        <div className={cn("pe-4 pb-3 empty:hidden", ROW_DEPTH_CLASS[depth])}>
          {footer}
        </div>
      )}
    </li>
  );
};

/** How a panel's content sits on the surface. `flush`: the content lays out
 *  its own rows edge to edge. */
type SettingsPanelInset = "padded" | "flush";

/**
 * A form, or other content that is not a row, on a section's surface. The
 * panel owns its inset; the content lays itself out inside it.
 */
const SettingsPanel = ({
  inset = "padded",
  ...props
}: Omit<React.ComponentProps<"li">, "className"> & {
  inset?: SettingsPanelInset | undefined;
}) => (
  <li
    data-slot="settings-panel"
    {...props}
    className={cn("block min-w-0", inset === "padded" && "p-4")}
  />
);

export { SettingsPanel, SettingsRow, settingsRowIds, SettingsSection };
export type { SettingsRowDepth, SettingsRowInteraction };
