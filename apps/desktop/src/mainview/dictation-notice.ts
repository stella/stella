/**
 * What the dictation notice panel says when a dictation heard nothing, and
 * the one action it offers. Mirrors `dictation_notice.rs`.
 */

import type { DesktopPlatform } from "../shared/shortcut-keys";

/** `microphone`: nothing could be heard; `nothingHeard`: sound, no words. */
export type DictationNoticeKind = "microphone" | "nothingHeard";

/**
 * `request` asks the OS for the microphone, `openSettings` opens its privacy
 * page, `openSound` opens the sound input settings.
 */
export type DictationNoticeFix = "openSettings" | "openSound" | "request";

export type DictationNoticeSnapshot = {
  fix: DictationNoticeFix | null;
  /** The input device the dictation listened to, as the OS names it. */
  inputDevice: string | null;
  kind: DictationNoticeKind;
};

export type DictationNoticeAction = "dismiss" | "fix";

const KINDS: readonly unknown[] = ["microphone", "nothingHeard"];
const FIXES: readonly unknown[] = [
  null,
  "openSettings",
  "openSound",
  "request",
];

export const isDictationNoticeSnapshot = (
  value: unknown,
): value is DictationNoticeSnapshot => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("fix" in value) ||
    !("kind" in value) ||
    !("inputDevice" in value)
  ) {
    return false;
  }
  return (
    FIXES.includes(value.fix) &&
    KINDS.includes(value.kind) &&
    (value.inputDevice === null || typeof value.inputDevice === "string")
  );
};

/** Message keys under `dictation.notice`. */
export type DictationNoticeCopy = {
  title: "nothingTitle" | "title";
  body: "allowBody" | "checkBodyMac" | "checkBodyPc" | "nothingBody";
  /** The action button's key, or null where there is nothing to open. */
  action:
    | "allow"
    | "openSettingsMac"
    | "openSettingsPc"
    | "openSoundMac"
    | "openSoundPc"
    | null;
};

export const dictationNoticeCopy = (
  { fix, kind }: Pick<DictationNoticeSnapshot, "fix" | "kind">,
  platform: DesktopPlatform,
): DictationNoticeCopy => {
  const mac = platform === "mac";
  if (kind === "nothingHeard") {
    return {
      action: fix === null ? null : soundAction(mac),
      body: "nothingBody",
      title: "nothingTitle",
    };
  }
  if (fix === "request") {
    return { action: "allow", body: "allowBody", title: "title" };
  }
  const body = mac ? "checkBodyMac" : "checkBodyPc";
  if (fix === null) {
    return { action: null, body, title: "title" };
  }
  return {
    action: mac ? "openSettingsMac" : "openSettingsPc",
    body,
    title: "title",
  };
};

const soundAction = (mac: boolean) => (mac ? "openSoundMac" : "openSoundPc");
