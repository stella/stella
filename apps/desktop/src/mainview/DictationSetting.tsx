import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Result } from "better-result";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Switch } from "@stll/ui/switch";

import { formatShortcut } from "../shared/shortcut-keys";
import type { ShortcutKeys } from "../shared/shortcut-keys";
import {
  DESKTOP_PLATFORM,
  useKeyboardLayout,
} from "../shared/use-clipboard-shortcut";

type DictationModel =
  | { status: "missing" | "failed" | "ready" }
  | { received: number; status: "downloading"; total: number };

type DictationSnapshot = {
  available: boolean;
  enabled: boolean;
  failure:
    "accessibility" | "microphone" | "modelMissing" | "transcription" | null;
  keys: ShortcutKeys;
  model: DictationModel;
  modelBytes: number;
  phase: "idle" | "recording" | "transcribing";
  shortcutTaken: boolean;
};

const BYTES_PER_MEGABYTE = 1_000_000;
const PERCENT = 100;

/** Local dictation: the switch, the speech model and what went wrong. */
export const DictationSetting = () => {
  const t = useTranslations("dictation");
  const locale = useLocale();
  const layout = useKeyboardLayout();
  const [snapshot, setSnapshot] = useState<DictationSnapshot | null>(null);

  useEffect(() => {
    const refresh = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<DictationSnapshot>("dictation_get_snapshot"),
      );
      if (Result.isOk(result)) {
        setSnapshot(result.value);
      }
    };
    void refresh();
    const listening = listen("dictation-changed", () => {
      void refresh();
    });
    const stopListening = async () => {
      const unlisten = await listening;
      unlisten();
    };
    return () => {
      void stopListening();
    };
  }, []);

  if (snapshot === null || !snapshot.available) {
    return null;
  }

  const shortcut = formatShortcut({
    keys: snapshot.keys,
    layout,
    locale,
    platform: DESKTOP_PLATFORM,
  });

  const setEnabled = async (enabled: boolean) => {
    const result = await Result.tryPromise(async () =>
      invoke<DictationSnapshot>("dictation_set_enabled", { enabled }),
    );
    if (Result.isOk(result)) {
      setSnapshot(result.value);
    }
  };

  const download = async () => {
    const result = await Result.tryPromise(async () =>
      invoke<DictationSnapshot>("dictation_download_model"),
    );
    if (Result.isOk(result)) {
      setSnapshot(result.value);
    }
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("title")}</p>
          <p
            className="text-muted-foreground mt-1 text-sm leading-relaxed"
            id="dictation-description"
          >
            {t("description", { shortcut })}
          </p>
        </div>
        <Switch
          aria-describedby="dictation-description"
          aria-label={t("title")}
          checked={snapshot.enabled}
          onCheckedChange={(enabled) => {
            void setEnabled(enabled);
          }}
        />
      </div>
      {snapshot.enabled && (
        <DictationModelRow
          model={snapshot.model}
          modelBytes={snapshot.modelBytes}
          onDownload={() => {
            void download();
          }}
        />
      )}
      {snapshot.shortcutTaken && (
        <p className="text-destructive text-sm">
          {t("shortcutTaken", { shortcut })}
        </p>
      )}
      {snapshot.failure !== null && (
        <p className="text-destructive text-sm" role="status">
          {t(`failure.${snapshot.failure}`)}
        </p>
      )}
    </div>
  );
};

const DictationModelRow = ({
  model,
  modelBytes,
  onDownload,
}: {
  model: DictationModel;
  modelBytes: number;
  onDownload: () => void;
}) => {
  const t = useTranslations("dictation");

  if (model.status === "ready") {
    return (
      <p className="text-muted-foreground text-xs">{t("modelAttribution")}</p>
    );
  }
  if (model.status === "downloading") {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        {t("downloading", {
          percent: Math.floor((model.received / model.total) * PERCENT),
        })}
      </p>
    );
  }
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-muted-foreground min-w-0 flex-1 text-sm">
        {model.status === "failed" ? t("downloadFailed") : t("modelNeeded")}
      </p>
      <Button onClick={onDownload} size="sm" variant="outline">
        {t("download", {
          size: Math.round(modelBytes / BYTES_PER_MEGABYTE),
        })}
      </Button>
    </div>
  );
};
