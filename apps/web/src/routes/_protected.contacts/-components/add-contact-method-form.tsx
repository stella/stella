import { useFormStatus } from "react-dom";

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
    action={() => {
      onSubmit();
    }}
    className="flex gap-2"
    noValidate
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
    <AddContactMethodSubmitButton
      buttonLabel={buttonLabel}
      disabled={disabled || value.trim().length === 0}
    />
  </form>
);

const AddContactMethodSubmitButton = ({
  buttonLabel,
  disabled,
}: {
  buttonLabel: string;
  disabled: boolean;
}) => {
  const { pending } = useFormStatus();
  return (
    <Button disabled={disabled || pending} size="sm" type="submit">
      <PlusIcon className="size-4" />
      {buttonLabel}
    </Button>
  );
};
