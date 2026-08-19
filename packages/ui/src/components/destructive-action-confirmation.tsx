"use client";

import * as React from "react";

import { cn } from "../lib/utils";
import { Field, FieldDescription, FieldLabel } from "./field";
import { Input } from "./input";
import type { InputProps } from "./input";

type DestructiveActionConfirmationProps = Omit<
  InputProps,
  "onChange" | "type" | "value"
> & {
  confirmation: string;
  description?: React.ReactNode;
  fieldClassName?: string;
  inputClassName?: string;
  label: React.ReactNode;
  onValueChange: (value: string) => void;
  value: string;
};

const DestructiveActionConfirmation = ({
  className,
  confirmation,
  description,
  fieldClassName,
  inputClassName,
  label,
  onValueChange,
  value,
  ...props
}: DestructiveActionConfirmationProps) => {
  const confirmed = isDestructiveActionConfirmed({ confirmation, value });
  const invalid = value.length >= confirmation.length && !confirmed;

  return (
    <Field className={fieldClassName} data-confirmed={confirmed || undefined}>
      <FieldLabel>{label}</FieldLabel>
      {description !== undefined ? (
        <FieldDescription>{description}</FieldDescription>
      ) : null}
      <code
        className={cn(
          "bg-muted text-foreground max-w-full rounded-md border px-2 py-1 font-mono text-xs break-all",
          className,
        )}
        data-slot="destructive-action-confirmation-phrase"
      >
        {confirmation}
      </code>
      <Input
        aria-invalid={invalid || undefined}
        autoCapitalize="none"
        autoComplete="off"
        className={inputClassName}
        data-slot="destructive-action-confirmation-input"
        spellCheck={false}
        {...props}
        // After the spread on purpose: the props type omits these three so the
        // field stays controlled by `value`/`onValueChange`, but an omit only
        // rejects a literal attribute. A props object typed wider stays
        // assignable and carries them through the spread, which would replace
        // the confirmation handler or the compared value.
        onChange={(event) => {
          onValueChange(event.currentTarget.value);
        }}
        type="text"
        value={value}
      />
    </Field>
  );
};

function useDestructiveActionConfirmation(confirmation: string) {
  const [value, setValue] = React.useState("");
  const confirmed = isDestructiveActionConfirmed({ confirmation, value });

  return {
    confirmed,
    onValueChange: setValue,
    reset: () => {
      setValue("");
    },
    value,
  };
}

function isDestructiveActionConfirmed({
  confirmation,
  value,
}: {
  confirmation: string;
  value: string;
}) {
  return value === confirmation;
}

export { DestructiveActionConfirmation, useDestructiveActionConfirmation };
