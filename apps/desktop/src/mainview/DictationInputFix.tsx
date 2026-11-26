import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import {
  dictationNoticeCopy,
  isDictationNoticeSnapshot,
} from "./dictation-notice";
import type { DictationNoticeSnapshot } from "./dictation-notice";

/**
 * The action under a Settings → Dictation failure line when a dictation
 * heard nothing, the same one its notification and panel offer: where a
 * click on the notification lands.
 */
export const DictationInputFix = () => {
  const t = useTranslations("dictation.notice");
  const [snapshot, setSnapshot] = useState<DictationNoticeSnapshot | null>(
    null,
  );

  useEffect(() => {
    let disposed = false;
    const read = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_notice_get_state"),
      );
      if (disposed) {
        return;
      }
      if (Result.isError(result) || !isDictationNoticeSnapshot(result.value)) {
        reportFailure();
        return;
      }
      setSnapshot(result.value);
    };
    void read();
    return () => {
      disposed = true;
    };
  }, []);

  if (snapshot === null) {
    return null;
  }
  const { action } = dictationNoticeCopy(snapshot, DESKTOP_PLATFORM);
  if (action === null) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      {snapshot.inputDevice === null ? null : (
        <p className="text-muted-foreground text-sm">
          {t("inputDevice", { device: snapshot.inputDevice })}
        </p>
      )}
      <Button
        onClick={() => {
          void Result.tryPromise(async () =>
            invoke("dictation_notice_respond", { action: "fix" }),
          ).then((result) => {
            if (Result.isError(result)) {
              reportFailure();
            }
            return;
          });
        }}
        variant="outline"
      >
        {t(action)}
      </Button>
    </div>
  );
};

const reportFailure = () => {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
    window: DESKTOP_TELEMETRY_WINDOWS.main,
  });
};
