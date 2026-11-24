import type { ReactNode } from "react";

import {
  FaceLabelPending,
  FieldTriggerFace,
  InputFace,
  LabelFace,
  SwitchFace,
} from "@stll/ui/control-face";
import type { ListGroupTitleTone } from "@stll/ui/list-shell";
import { SettingsRow, SettingsSection } from "@stll/ui/settings";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

/*
 * The settings section and the form field, each beside its pending phase,
 * for every settings-shaped page (account, organization, admin forms):
 *
 * - `SettingsSectionPending` is a `SettingsSection` (`@stll/ui/settings`)
 *   whose title and line are static messages, drawn through `PendingText`
 *   so the header that loads keeps its box. Its rows and panels are the
 *   caller's. A section whose title is data renders `SettingsSection`.
 * - `SettingsSwitchRowPending` is a switch row while its value loads: the
 *   title and line, and the switch's face, off.
 * - `FormField` is one field's column: its caption, an optional quiet line,
 *   then the control, at the width the caller gives it (`max-w-lg` for a
 *   name, `max-w-xs` for a short code). `FormFieldSkeleton` is the same
 *   column with the caption and the line through `PendingText` and the
 *   control's face at the real control's size.
 *
 * None reads a provider, so a pending view the server paints before the app
 * mounts draws them, and the page that loads draws the real section and
 * field in the same boxes.
 */

type SettingsSectionPendingProps = {
  title: PendingTextKey;
  description?: PendingTextKey | undefined;
  tone?: ListGroupTitleTone | undefined;
  /** A quiet trailing action on the header row. */
  action?: ReactNode;
  /** `SettingsRow`s and `SettingsPanel`s. */
  children: ReactNode;
};

/** A settings section whose title and line are static messages. */
export const SettingsSectionPending = ({
  action,
  children,
  description,
  title,
  tone,
}: SettingsSectionPendingProps) => (
  <SettingsSection
    action={action}
    description={
      description === undefined ? undefined : (
        <PendingText barClassName="w-72 max-w-full" id={description} />
      )
    }
    title={<PendingText barClassName="w-28" id={title} />}
    tone={tone}
  >
    {children}
  </SettingsSection>
);

/**
 * A switch row while its value loads: the switch's face, off, at the end of
 * the row the live `SettingsRow` draws.
 */
export const SettingsSwitchRowPending = ({
  description,
  title,
}: {
  title: PendingTextKey;
  description: PendingTextKey;
}) => (
  <SettingsRow
    description={
      <PendingText barClassName="w-72 max-w-full" id={description} />
    }
    title={<PendingText barClassName="w-40" id={title} />}
  >
    <SwitchFace />
  </SettingsRow>
);

/** A `Form`'s column (`@stll/ui/form`, `stack`), for a form's stand-in. */
export const FORM_STACK_CLASS = "flex w-full flex-col gap-4";

type FormFieldProps = {
  /** The caption (a `Label` bound to the control); none when the section's
   *  title already names the field. */
  label?: ReactNode;
  /** One quiet line between the caption and the control. */
  description?: ReactNode;
  /** The column's width (`max-w-lg`, `max-w-xs`). */
  className?: string | undefined;
  /** The control. */
  children: ReactNode;
};

/** One field's column: caption, quiet line, control. */
export const FormField = ({
  children,
  className,
  description,
  label,
}: FormFieldProps) => (
  <div className={cn("flex flex-col gap-2", className)}>
    {label}
    {description !== undefined && (
      <p className="text-muted-foreground text-sm">{description}</p>
    )}
    {children}
  </div>
);

type FormFieldSkeletonProps = {
  label?: PendingTextKey | undefined;
  description?: PendingTextKey | undefined;
  /** The control's face: a text field, or a picker's trigger. */
  control?: "input" | "picker" | undefined;
  className?: string | undefined;
};

/**
 * A field in its pending phase: the caption and the line through
 * `PendingText`, and the face of the control at its size, empty (the value
 * waits on data).
 */
export const FormFieldSkeleton = ({
  className,
  control = "input",
  description,
  label,
}: FormFieldSkeletonProps) => (
  <FormField
    className={className}
    description={
      description === undefined ? undefined : (
        <PendingText barClassName="w-72 max-w-full" id={description} />
      )
    }
    label={
      label === undefined ? undefined : (
        <LabelFace>
          <PendingText barClassName="w-28" id={label} />
        </LabelFace>
      )
    }
  >
    {control === "input" ? (
      <InputFace />
    ) : (
      <FieldTriggerFace>
        <FaceLabelPending className="w-40" />
      </FieldTriggerFace>
    )}
  </FormField>
);
