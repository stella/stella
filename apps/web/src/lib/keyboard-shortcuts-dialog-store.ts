import { create } from "zustand";

/**
 * Open state for the keyboard-shortcuts cheatsheet dialog, lifted into a store
 * so it can be opened from anywhere (the `?` hotkey and the Settings entry)
 * while the dialog itself stays mounted once at the protected-layout level.
 */
type KeyboardShortcutsDialogState = {
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly setOpen: (isOpen: boolean) => void;
};

export const useKeyboardShortcutsDialogStore =
  create<KeyboardShortcutsDialogState>((set) => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    setOpen: (isOpen) => set({ isOpen }),
  }));
