// Passive regression fixture for
// `no-ambient-hotkey-format/no-ambient-hotkey-format`.

// oxlint-disable-next-line no-ambient-hotkey-format/no-ambient-hotkey-format -- fixture: aliased ambient detection must be rejected
import { detectPlatform as rawDetectPlatform } from "@tanstack/hotkeys";
// Namespace imports could bypass named-export checks, so they must fail too.
// oxlint-disable-next-line no-ambient-hotkey-format/no-ambient-hotkey-format -- fixture: raw namespace import must be rejected
import * as rawHotkeys from "@tanstack/react-hotkeys";
// oxlint-disable-next-line no-ambient-hotkey-format/no-ambient-hotkey-format -- fixture: aliased ambient formatting must be rejected
import { formatForDisplay as rawFormat } from "@tanstack/react-hotkeys";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";

export const __noAmbientHotkeyFormatFixture: readonly unknown[] = [
  rawHotkeys,
  rawDetectPlatform,
  rawFormat,
  useHotkey,
  undefined satisfies Hotkey | undefined,
];
