import type { ReactNode } from "react";

import {
  FaceLabelPending,
  FieldTriggerFace,
  InputFace,
  LabelFace,
} from "@stll/ui/control-face";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FrameTitle,
} from "@stll/ui/frame";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

/*
 * The settings card and the form field, each beside its pending phase, for
 * every settings-shaped page (account, organization, admin forms, the auth
 * forms):
 *
 * - `SettingsCard` is a titled card: a `Frame` whose header holds the title
 *   and one quiet line, over the panels the page puts in it. A `destructive`
 *   card (a danger zone) takes the destructive title.
 *   `SettingsCardPending` is the same card with its title and line through
 *   `PendingText`, so the header that loads keeps its box; its panels are the
 *   caller's (form fields, rows, a control's face).
 * - `FormField` is one field's column: its caption, an optional quiet line,
 *   then the control, at the width the caller gives it (`max-w-lg` for a
 *   name, `max-w-xs` for a short code). `FormFieldSkeleton` is the same
 *   column with the caption and the line through `PendingText` and the
 *   control's face at the real control's size: a text field's box, or a
 *   picker's trigger with a bar where its choice will be.
 *
 * Neither reads a provider, so a pending view the server paints before the
 * app mounts draws them, and the page that loads draws the real card and
 * field in the same boxes.
 */

/** `destructive` takes the destructive title (a danger zone). */
type SettingsCardTone = "default" | "destructive";

type SettingsCardProps = {
  title: ReactNode;
  /** The card's one quiet line under its title. */
  description?: ReactNode;
  tone?: SettingsCardTone | undefined;
  /** The card's panels (`FramePanel`s), or what stands in for them. */
  children: ReactNode;
};

/** A titled settings card: the header over the panels the page puts in. */
export const SettingsCard = ({
  children,
  description,
  title,
  tone = "default",
}: SettingsCardProps) => (
  <Frame>
    <FrameHeader>
      <FrameTitle tone={tone}>{title}</FrameTitle>
      {description !== undefined && (
        <FrameDescription>{description}</FrameDescription>
      )}
    </FrameHeader>
    {children}
  </Frame>
);

type SettingsCardPendingProps = {
  title: PendingTextKey;
  description?: PendingTextKey | undefined;
  tone?: SettingsCardTone | undefined;
  children: ReactNode;
};

/**
 * A settings card in its pending phase: the real header with its title and
 * line through `PendingText`, over the caller's pending panels.
 */
export const SettingsCardPending = ({
  children,
  description,
  title,
  tone,
}: SettingsCardPendingProps) => (
  <SettingsCard
    description={
      description === undefined ? undefined : (
        <PendingText barClassName="w-72 max-w-full" id={description} />
      )
    }
    title={<PendingText barClassName="w-28" id={title} />}
    tone={tone}
  >
    {children}
  </SettingsCard>
);

type FormFieldProps = {
  /** The caption (a `Label` bound to the control); none when the card's
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
