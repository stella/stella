// Passive regression fixture for
// `no-ambient-hotkey-format/no-ambient-hotkey-format`.

// Namespace imports could bypass named-export checks, so they must fail too.
// oxlint-disable-next-line no-ambient-hotkey-format/no-ambient-hotkey-format -- fixture: raw namespace import must be rejected
import * as rawHotkeys from "@tanstack/hotkeys";
// oxlint-disable-next-line no-ambient-hotkey-format/no-ambient-hotkey-format -- fixture: aliased ambient formatting must be rejected
import {
  detectPlatform as rawPlatform,
  formatForDisplay as raw,
  useHotkey,
} from "@tanstack/react-hotkeys";

export const __noAmbientHotkeyFormatFixture: readonly unknown[] = [
  rawHotkeys,
  rawHotkeys.detectPlatform,
  rawPlatform,
  raw,
  useHotkey,
];
