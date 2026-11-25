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
 * the web's colours (the green track when on, the grey one when off, a
 * white thumb on both).
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
      ios_backgroundColorClassName="accent-switch-track"
      onValueChange={(next) => {
        setOwn(next);
        onCheckedChange?.(next);
      }}
      thumbColorClassName="accent-switch-thumb"
      trackColorOffClassName="accent-switch-track"
      trackColorOnClassName="accent-switch-track-checked"
      value={value}
    />
  );
};
