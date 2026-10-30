import { useHotkey } from "@tanstack/react-hotkeys";
import type { HotkeyChord } from "@tanstack/react-hotkeys";

import { useQuickEntryStore } from "@/lib/workspaces/quick-entry-store";

type QuickEntryScope = Parameters<
  ReturnType<typeof useQuickEntryStore.getState>["openDialog"]
>[0];

type UseQuickEntryHotkeyOptions = {
  enabled: boolean;
  hotkey: HotkeyChord;
  scope: QuickEntryScope;
};

export const useQuickEntryHotkey = ({
  enabled,
  hotkey,
  scope,
}: UseQuickEntryHotkeyOptions) => {
  const openDialog = useQuickEntryStore((state) => state.openDialog);
  useHotkey(hotkey, () => openDialog(scope), { enabled });
};
