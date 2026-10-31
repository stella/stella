import { createContext, use } from "react";
import type { ComponentProps } from "react";

import type { ViewProps } from "react-native";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  View,
} from "react-native";

import { cn } from "../lib/utils";
import { Button } from "./button.native";
import type { SheetContract } from "./sheet.shared";
import { Text } from "./text.native";

/** Closes the sheet that holds it; nothing outside a sheet. */
const SheetCloseContext = createContext<() => void>(() => undefined);

/**
 * The web's `Sheet` (./sheet.tsx) on a phone: the platform's page sheet,
 * sliding up over the screen. A swipe down or the system back gesture asks
 * to close it through `onOpenChange(false)`, as Escape does on the web.
 */
export const Sheet = ({
  children,
  onOpenChange,
  open = false,
}: SheetContract) => {
  const close = () => {
    onOpenChange?.(false);
  };
  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      presentationStyle="pageSheet"
      visible={open}
    >
      <SheetCloseContext value={close}>{children}</SheetCloseContext>
    </Modal>
  );
};

/** The sheet's surface: the background, inset, and room for the keyboard. */
export const SheetPopup = ({
  className,
  ...props
}: ViewProps & { className?: string | undefined }) => (
  <KeyboardAvoidingView
    behavior={Platform.OS === "ios" ? "padding" : undefined}
    className={cn("bg-background flex-1 gap-4 px-5 pt-5", className)}
    {...props}
  />
);

/** The title row: the title leading, a close or done action trailing. */
export const SheetHeader = ({
  className,
  ...props
}: ViewProps & { className?: string | undefined }) => (
  <View
    className={cn("flex-row items-center justify-between gap-4", className)}
    {...props}
  />
);

export const SheetTitle = (props: ComponentProps<typeof Text>) => (
  <Text accessibilityRole="header" variant="headline" {...props} />
);

export const SheetDescription = (props: ComponentProps<typeof Text>) => (
  <Text variant="caption" {...props} />
);

/** The sheet's body, scrolling when it outgrows the sheet. */
export const SheetPanel = ({
  contentContainerClassName,
  ...props
}: ComponentProps<typeof ScrollView>) => (
  <ScrollView
    contentContainerClassName={cn("gap-4", contentContainerClassName)}
    keyboardShouldPersistTaps="handled"
    {...props}
  />
);

/** A button that closes the sheet, after its own `onPress`. */
export const SheetClose = ({
  onPress,
  size = "sm",
  variant = "ghost",
  ...props
}: ComponentProps<typeof Button>) => {
  const close = use(SheetCloseContext);
  return (
    <Button
      onPress={(event) => {
        onPress?.(event);
        close();
      }}
      size={size}
      variant={variant}
      {...props}
    />
  );
};
