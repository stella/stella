/**
 * What the dictation notice panel says when dictation could not hear the
 * microphone, and the one action it offers. Mirrors `dictation_notice.rs`.
 */

import type { DesktopPlatform } from "../shared/shortcut-keys";

/** `request` asks the OS for the microphone; `openSettings` opens its page. */
export type MicrophoneFix = "openSettings" | "request";

export type DictationNoticeSnapshot = { fix: MicrophoneFix | null };

export type DictationNoticeAction = "dismiss" | "fix";

export const isDictationNoticeSnapshot = (
  value: unknown,
): value is DictationNoticeSnapshot => {
  if (typeof value !== "object" || value === null || !("fix" in value)) {
    return false;
  }
  return (
    value.fix === null ||
    value.fix === "request" ||
    value.fix === "openSettings"
  );
};

export type DictationNoticeCopy = {
  /** Message key under `dictation.notice`. */
  body: "allowBody" | "checkBodyMac" | "checkBodyPc";
  /** The action button's key, or null where there is nothing to open. */
  action: "allow" | "openSettingsMac" | "openSettingsPc" | null;
};

export const dictationNoticeCopy = (
  fix: MicrophoneFix | null,
  platform: DesktopPlatform,
): DictationNoticeCopy => {
  if (fix === "request") {
    return { action: "allow", body: "allowBody" };
  }
  const mac = platform === "mac";
  const body = mac ? "checkBodyMac" : "checkBodyPc";
  if (fix === null) {
    return { action: null, body };
  }
  return { action: mac ? "openSettingsMac" : "openSettingsPc", body };
};
