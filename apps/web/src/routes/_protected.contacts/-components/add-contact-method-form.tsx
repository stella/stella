import { PlusIcon } from "lucide-react";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";

export const AddContactMethodForm = ({
  buttonLabel,
  disabled,
  inputMode,
  maxLength,
  onSubmit,
  onValueChange,
  placeholder,
  type = "text",
  value,
}: {
  buttonLabel: string;
  disabled: boolean;
  inputMode?: "email" | "tel";
  maxLength?: number;
  onSubmit: () => void;
  onValueChange: (value: string) => void;
  placeholder: string;
  type?: "text";
  value: string;
}) => (
  <form
    className="flex gap-2"
    noValidate
    onSubmit={(event) => {
      event.preventDefault();
      onSubmit();
    }}
  >
    <Input
      className="h-8 min-w-0 flex-1 text-sm"
      disabled={disabled}
      inputMode={inputMode}
      maxLength={maxLength}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      placeholder={placeholder}
      type={type}
      value={value}
    />
    <Button
      disabled={disabled || value.trim().length === 0}
      size="sm"
      type="submit"
    >
      <PlusIcon className="size-4" />
      {buttonLabel}
    </Button>
  </form>
);
