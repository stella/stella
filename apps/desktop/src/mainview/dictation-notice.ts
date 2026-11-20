/**
 * What the dictation notice panel says when a dictation heard nothing, and
 * the one action it offers. Mirrors `dictation_notice.rs`.
 */

import type { DesktopPlatform } from "../shared/shortcut-keys";

/** `microphone`: nothing could be heard; `nothingHeard`: sound, no words. */
type DictationNoticeKind = "microphone" | "microphoneMissing" | "nothingHeard";

/**
 * `request` asks the OS for the microphone, `openSettings` opens its privacy
 * page, `openSound` opens the sound input settings.
 */
type DictationNoticeFix =
  "chooseMicrophone" | "openSettings" | "openSound" | "request";

export type DictationNoticeSnapshot = {
  fix: DictationNoticeFix | null;
  /** The input device the dictation listened to, as the OS names it. */
  inputDevice: string | null;
  kind: DictationNoticeKind;
  /** The chosen microphone that was not connected. */
  missing: string | null;
};

export type DictationNoticeAction = "chooseMicrophone" | "dismiss" | "fix";

const KINDS: readonly unknown[] = [
  "microphone",
  "microphoneMissing",
  "nothingHeard",
];
const FIXES: readonly unknown[] = [
  null,
  "chooseMicrophone",
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
    !("inputDevice" in value) ||
    !("missing" in value)
  ) {
    return false;
  }
  return (
    FIXES.includes(value.fix) &&
    KINDS.includes(value.kind) &&
    (value.inputDevice === null || typeof value.inputDevice === "string") &&
    (value.missing === null || typeof value.missing === "string")
  );
};

/** Message keys under `dictation.notice`. */
type DictationNoticeCopy = {
  title: "missingTitle" | "nothingTitle" | "title";
  body:
    | "allowBody"
    | "checkBodyMac"
    | "checkBodyPc"
    | "missingBody"
    | "nothingBody";
  /** The action button's key, or null where there is nothing to open. */
  action:
    | "allow"
    | "chooseMicrophone"
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
  if (kind === "microphoneMissing") {
    return {
      action: "chooseMicrophone",
      body: "missingBody",
      title: "missingTitle",
    };
  }
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
