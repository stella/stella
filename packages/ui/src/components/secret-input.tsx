"use client";

import { useState } from "react";

import { EyeIcon, EyeOffIcon } from "lucide-react";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import type { InputProps } from "@stll/ui/components/input";
import { cn } from "@stll/ui/lib/utils";

type SecretInputProps = Omit<InputProps, "type"> & {
  hideValueLabel: string;
  showValueLabel: string;
};

const SecretInput = ({
  className,
  dir,
  disabled,
  hideValueLabel,
  showValueLabel,
  ...props
}: SecretInputProps) => {
  const [visibility, setVisibility] = useState<"concealed" | "revealed">(
    "concealed",
  );
  const isRevealed = visibility === "revealed";
  const label = isRevealed ? hideValueLabel : showValueLabel;

  return (
    <span
      className="relative inline-flex w-full"
      data-slot="secret-input"
      dir={dir ?? "ltr"}
    >
      <Input
        className={cn("**:[input]:pe-9", className)}
        disabled={disabled}
        {...props}
        dir={dir ?? "ltr"}
        type={isRevealed ? "text" : "password"}
      />
      <Button
        aria-label={label}
        aria-pressed={isRevealed}
        className="text-muted-foreground hover:text-foreground absolute end-1 top-1/2 z-1 -translate-y-1/2"
        data-slot="secret-input-visibility-toggle"
        disabled={disabled}
        onClick={() => setVisibility(isRevealed ? "concealed" : "revealed")}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        {isRevealed ? (
          <EyeOffIcon aria-hidden="true" />
        ) : (
          <EyeIcon aria-hidden="true" />
        )}
      </Button>
    </span>
  );
};

export { SecretInput, type SecretInputProps };
