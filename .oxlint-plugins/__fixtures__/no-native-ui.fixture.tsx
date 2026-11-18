// Passive regression fixture for the `no-native-ui` rules, one generated rule
// per @stll/ui component (.oxlint-plugins/no-native-ui-registry.ts).
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import type { ComponentProps } from "react";

import {
  ActivityIndicator,
  Modal,
  Pressable,
  Text as PlatformText,
  TextInput,
} from "react-native";

import { Input } from "@stll/ui/input";
import { MenuCheckboxItem } from "@stll/ui/menu";
import { Switch } from "@stll/ui/switch";
import { Text } from "@stll/ui/text";

const Box = (props: ComponentProps<"span">) => <span {...props} />;

// --- Flagged: native markup a design-system component already wraps ---
export const _flagged = ({ id, label }: { id: string; label: string }) => (
  <>
    {/* oxlint-disable-next-line no-native-ui/no-native-accordion */}
    <details />
    {/* oxlint-disable-next-line no-native-ui/no-native-alert-dialog */}
    <Box role="alertdialog" />
    {/* oxlint-disable-next-line no-native-ui/no-native-button */}
    <button type="button">{label}</button>
    {/* oxlint-disable-next-line no-native-ui/no-native-checkbox */}
    <Input aria-label={label} type="checkbox" />
    {/* oxlint-disable-next-line no-native-ui/no-native-color-picker */}
    <Input aria-label={label} type="color" />
    {/* oxlint-disable-next-line no-native-ui/no-native-combobox */}
    <Box aria-controls={id} aria-expanded={false} role="combobox" />
    {/* oxlint-disable-next-line no-native-ui/no-native-details-grid */}
    <dl />
    {/* oxlint-disable-next-line no-native-ui/no-native-dialog */}
    <dialog />
    {/* oxlint-disable-next-line no-native-ui/no-native-form */}
    <form />
    {/* oxlint-disable-next-line no-native-ui/no-native-input */}
    <input aria-label={label} />
    {/* oxlint-disable-next-line no-native-ui/no-native-input-otp */}
    <input aria-label={label} autoComplete="one-time-code" type="hidden" />
    {/* oxlint-disable-next-line no-native-ui/no-native-label */}
    <label htmlFor={id}>{label}</label>
    {/* oxlint-disable-next-line no-native-ui/no-native-menu */}
    <Box role="menuitem" />
    {/* oxlint-disable-next-line no-native-ui/no-native-number-input */}
    <Input aria-label={label} type="number" />
    {/* oxlint-disable-next-line no-native-ui/no-native-popover */}
    <div popover="auto" />
    {/* oxlint-disable-next-line no-native-ui/no-native-secret-input */}
    <Input aria-label={label} type="password" />
    {/* oxlint-disable-next-line no-native-ui/no-native-select */}
    <select aria-label={label} />
    {/* oxlint-disable-next-line no-native-ui/no-native-separator */}
    <hr />
    {/* oxlint-disable-next-line no-native-ui/no-native-switch */}
    <Box aria-checked={false} role="switch" />
    {/* oxlint-disable-next-line no-native-ui/no-native-table */}
    <table />
    {/* oxlint-disable-next-line no-native-ui/no-native-tabs */}
    <Box role="tab" />
    {/* oxlint-disable-next-line no-native-ui/no-native-textarea */}
    <textarea aria-label={label} />
    {/* oxlint-disable-next-line no-native-ui/no-native-tooltip */}
    <span title={label} />
  </>
);

// --- Flagged: React Native components a native renderer already wraps ---
export const _flaggedReactNative = ({ label }: { label: string }) => (
  <>
    {/* oxlint-disable-next-line no-native-ui/no-native-button */}
    <Pressable accessibilityLabel={label} />
    {/* oxlint-disable-next-line no-native-ui/no-native-loader */}
    <ActivityIndicator />
    {/* oxlint-disable-next-line no-native-ui/no-native-sheet */}
    <Modal visible={false} />
    {/* oxlint-disable-next-line no-native-ui/no-native-text */}
    <PlatformText>{label}</PlatformText>
    {/* oxlint-disable-next-line no-native-ui/no-native-input */}
    <TextInput accessibilityLabel={label} />
    {/* oxlint-disable-next-line no-native-ui/no-native-textarea */}
    <TextInput accessibilityLabel={label} multiline />
  </>
);

// --- Allowed: the design-system components and their near misses ---
export const _allowed = ({
  label,
  on,
  setOn,
}: {
  label: string;
  on: boolean;
  setOn: (checked: boolean) => void;
}) => (
  <>
    {/* expect-clean: no-native-ui/no-native-accordion, no-native-ui/no-native-alert-dialog, no-native-ui/no-native-button, no-native-ui/no-native-checkbox, no-native-ui/no-native-color-picker, no-native-ui/no-native-combobox, no-native-ui/no-native-details-grid, no-native-ui/no-native-dialog, no-native-ui/no-native-form, no-native-ui/no-native-input, no-native-ui/no-native-input-otp, no-native-ui/no-native-label, no-native-ui/no-native-menu, no-native-ui/no-native-number-input, no-native-ui/no-native-popover, no-native-ui/no-native-secret-input, no-native-ui/no-native-select, no-native-ui/no-native-separator, no-native-ui/no-native-switch, no-native-ui/no-native-table, no-native-ui/no-native-tabs, no-native-ui/no-native-textarea, no-native-ui/no-native-tooltip */}
    <Switch aria-label={label} checked={on} onCheckedChange={setOn} />
    {/* expect-clean: no-native-ui/no-native-accordion, no-native-ui/no-native-alert-dialog, no-native-ui/no-native-button, no-native-ui/no-native-checkbox, no-native-ui/no-native-color-picker, no-native-ui/no-native-combobox, no-native-ui/no-native-details-grid, no-native-ui/no-native-dialog, no-native-ui/no-native-form, no-native-ui/no-native-input, no-native-ui/no-native-input-otp, no-native-ui/no-native-label, no-native-ui/no-native-menu, no-native-ui/no-native-number-input, no-native-ui/no-native-popover, no-native-ui/no-native-secret-input, no-native-ui/no-native-select, no-native-ui/no-native-separator, no-native-ui/no-native-switch, no-native-ui/no-native-table, no-native-ui/no-native-tabs, no-native-ui/no-native-textarea, no-native-ui/no-native-tooltip */}
    <MenuCheckboxItem checked={on} variant="switch" />
    {/* expect-clean: no-native-ui/no-native-input, no-native-ui/no-native-checkbox, no-native-ui/no-native-number-input */}
    <Input aria-label={label} type="search" />
    {/* expect-clean: no-native-ui/no-native-tooltip */}
    <abbr title={label}>{label}</abbr>
    {/* expect-clean: no-native-ui/no-native-loader, no-native-ui/no-native-sheet, no-native-ui/no-native-text */}
    <Text variant="caption">{label}</Text>
  </>
);
