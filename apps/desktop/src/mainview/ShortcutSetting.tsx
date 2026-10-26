import { useCallback, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { Keycaps } from "../shared/Keycaps";
import {
  formatShortcut,
  isShortcutUpdate,
  sameShortcut,
  shortcutKeycaps,
} from "../shared/shortcut-keys";
import type { ShortcutKeys, ShortcutRejection } from "../shared/shortcut-keys";
import { ShortcutRecorder } from "../shared/ShortcutRecorder";
import { ShortcutRejectionText } from "../shared/ShortcutRejectionText";
import {
  DESKTOP_PLATFORM,
  useClipboardShortcut,
  useKeyboardLayout,
} from "../shared/use-clipboard-shortcut";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";

type ResetNotice =
  | { type: "none" }
  | { candidate: ShortcutKeys; rejection: ShortcutRejection; type: "rejected" }
  | { type: "error" };

/** The clipboard shortcut row: current keys, a recorder, and a reset. */
export const ShortcutSetting = () => {
  const t = useTranslations("shortcut");
  const locale = useLocale();
  const [snapshot, setSnapshot] = useClipboardShortcut(reportShortcutFailure);
  const layout = useKeyboardLayout();
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<ResetNotice>({ type: "none" });
  const stopRecording = useCallback(() => setRecording(false), []);

  if (!snapshot) {
    return null;
  }

  if (snapshot.registration === "managed") {
    return (
      <div className="px-4 py-3">
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
          {t("managed")}
        </p>
      </div>
    );
  }

  const label = (keys: ShortcutKeys) =>
    formatShortcut({ keys, layout, locale, platform: DESKTOP_PLATFORM });
  const changed = !sameShortcut(snapshot.keys, snapshot.defaultKeys);

  const reset = async () => {
    const result = await Result.tryPromise(async () =>
      invoke<unknown>("shortcut_set", { keys: snapshot.defaultKeys }),
    );
    if (Result.isError(result) || !isShortcutUpdate(result.value)) {
      reportShortcutFailure();
      setNotice({ type: "error" });
      return;
    }
    setSnapshot(result.value.snapshot);
    setNotice(
      result.value.status === "saved"
        ? { type: "none" }
        : {
            candidate: snapshot.defaultKeys,
            rejection: result.value.rejection,
            type: "rejected",
          },
    );
  };

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("title")}</p>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            {t("description")}
          </p>
        </div>
        {recording ? null : (
          <div className="flex shrink-0 items-center gap-2">
            <Keycaps
              caps={shortcutKeycaps({
                keys: snapshot.keys,
                layout,
                locale,
                platform: DESKTOP_PLATFORM,
              })}
            />
            <Button
              onClick={() => {
                setNotice({ type: "none" });
                setRecording(true);
              }}
              size="sm"
              variant="outline"
            >
              {t("change")}
            </Button>
          </div>
        )}
      </div>
      {recording ? (
        <ShortcutRecorder
          current={snapshot.keys}
          layout={layout}
          onCancel={stopRecording}
          onSaved={(next) => {
            setSnapshot(next);
            setRecording(false);
          }}
          window={DESKTOP_TELEMETRY_WINDOWS.main}
        />
      ) : null}
      {!recording && snapshot.registration === "unavailable" ? (
        <p className="text-destructive-foreground text-sm" role="alert">
          {t("unavailable", { shortcut: label(snapshot.keys) })}
        </p>
      ) : null}
      {!recording && notice.type === "error" ? (
        <p className="text-destructive-foreground text-sm" role="alert">
          {t("errorSave")}
        </p>
      ) : null}
      {!recording && notice.type === "rejected" ? (
        <p className="text-destructive-foreground text-sm" role="alert">
          <ShortcutRejectionText
            candidate={notice.candidate}
            layout={layout}
            rejection={notice.rejection}
          />
        </p>
      ) : null}
      {!recording && changed ? (
        <div className="flex justify-end">
          <Button
            onClick={() => {
              void reset();
            }}
            size="sm"
            variant="ghost"
          >
            {t("reset", { shortcut: label(snapshot.defaultKeys) })}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

function reportShortcutFailure() {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.shortcutUpdate,
    window: DESKTOP_TELEMETRY_WINDOWS.main,
  });
}
