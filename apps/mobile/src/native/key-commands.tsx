import { requireNativeView, requireOptionalNativeModule } from "expo";
import { StyleSheet } from "react-native";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

/** A hardware keyboard shortcut, named for the iPad's ⌘ overlay. */
export type KeyCommand = {
  readonly id: string;
  /** A key, or "escape", "up" or "down". */
  readonly input: string;
  readonly modifiers: readonly ("command" | "control" | "option" | "shift")[];
  readonly title: string;
};

type KeyCommandsProps = ViewProps & {
  readonly commands: readonly KeyCommand[];
  readonly onCommand: (event: NativeSyntheticEvent<{ id: string }>) => void;
};

// Absent on Android, the web and a client built before the shortcuts.
const NativeKeyCommands =
  requireOptionalNativeModule("KeyCommands") === null
    ? null
    : requireNativeView<KeyCommandsProps>("KeyCommands");

/**
 * Wraps the app so a hardware keyboard's shortcuts reach it from anywhere,
 * a text field being typed in too. Without the native view, as on Android,
 * it is only its children.
 */
export const KeyCommands = ({
  children,
  commands,
  onCommand,
}: React.PropsWithChildren<{
  commands: readonly KeyCommand[];
  onCommand: (id: string) => void;
}>) =>
  NativeKeyCommands === null ? (
    children
  ) : (
    <NativeKeyCommands
      commands={commands}
      onCommand={(event) => {
        onCommand(event.nativeEvent.id);
      }}
      style={StyleSheet.absoluteFill}
    >
      {children}
    </NativeKeyCommands>
  );
