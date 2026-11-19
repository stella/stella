import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DictateIcon, XIcon } from "@stll/ui/icons";

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
import type {
  DictationNoticeAction,
  DictationNoticeSnapshot,
} from "./dictation-notice";

/**
 * The panel shown where the speaker works when dictation could not hear the
 * microphone: what happened and the one action that fixes it. The native
 * side places it and closes it.
 */
const DictationNoticeApp = () => {
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
        // Still say what happened; only the action is unknown.
        setSnapshot({ fix: null });
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
    return <main className="dictation-notice-window" />;
  }
  const copy = dictationNoticeCopy(snapshot.fix, DESKTOP_PLATFORM);

  return (
    <main
      className="dictation-notice-window bg-background/90 text-foreground flex h-dvh items-start gap-3 rounded-2xl border p-3 ps-4 backdrop-blur"
      role="alert"
    >
      <DictateIcon
        aria-hidden="true"
        className="text-destructive-foreground mt-0.5 size-5 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-muted-foreground text-xs leading-snug">
          {t(copy.body)}
        </p>
        {copy.action === null ? null : (
          <Button
            className="mt-1"
            onClick={() => {
              respond("fix");
            }}
            size="sm"
          >
            {t(copy.action)}
          </Button>
        )}
      </div>
      <Button
        aria-label={t("dismiss")}
        className="shrink-0"
        onClick={() => {
          respond("dismiss");
        }}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon aria-hidden="true" />
      </Button>
    </main>
  );
};

const respond = (action: DictationNoticeAction) => {
  void Result.tryPromise(async () =>
    invoke("dictation_notice_respond", { action }),
  ).then((result) => {
    if (Result.isError(result)) {
      reportFailure();
    }
    return;
  });
};

const reportFailure = () => {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
    window: DESKTOP_TELEMETRY_WINDOWS.main,
  });
};

export default DictationNoticeApp;
