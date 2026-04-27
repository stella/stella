"use client";

import * as React from "react";

import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@stella/ui/components/field";
import { Input } from "@stella/ui/components/input";
import type { InputProps } from "@stella/ui/components/input";
import { cn } from "@stella/ui/lib/utils";

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

function DestructiveActionConfirmation({
  className,
  confirmation,
  description,
  fieldClassName,
  inputClassName,
  label,
  onValueChange,
  value,
  ...props
}: DestructiveActionConfirmationProps) {
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
        onChange={(event) => {
          onValueChange(event.currentTarget.value);
        }}
        spellCheck={false}
        type="text"
        value={value}
        {...props}
      />
    </Field>
  );
}

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

export {
  DestructiveActionConfirmation,
  isDestructiveActionConfirmed,
  useDestructiveActionConfirmation,
};
