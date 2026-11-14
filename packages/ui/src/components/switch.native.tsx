import { useState } from "react";

import type { SwitchProps as PlatformSwitchProps } from "react-native";
import { Switch as PlatformSwitch } from "react-native";

import type { SwitchContract } from "./switch.shared";

type SwitchProps = Omit<
  PlatformSwitchProps,
  "value" | "onValueChange" | "disabled" | keyof SwitchContract
> &
  SwitchContract;

/**
 * The web's `Switch` (./switch.tsx) on a phone: the platform's own switch, in
 * the web's colours (the primary fill when on, the input fill when off).
 * Controlled through `checked`, or holding its own state from
 * `defaultChecked`.
 */
export const Switch = ({
  checked,
  defaultChecked = false,
  disabled = false,
  onCheckedChange,
  ...props
}: SwitchProps) => {
  const [own, setOwn] = useState(defaultChecked);
  const value = checked ?? own;
  return (
    <PlatformSwitch
      {...props}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      ios_backgroundColorClassName="accent-input"
      onValueChange={(next) => {
        setOwn(next);
        onCheckedChange?.(next);
      }}
      thumbColorClassName="accent-background"
      trackColorOffClassName="accent-input"
      trackColorOnClassName="accent-primary"
      value={value}
    />
  );
};
