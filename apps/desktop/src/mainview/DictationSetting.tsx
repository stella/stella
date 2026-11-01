import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Switch } from "@stll/ui/switch";

import { subscribeDesktopEvent } from "../shared/desktop-events";
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

const isDictationSnapshot = (value: unknown): value is DictationSnapshot =>
  typeof value === "object" &&
  value !== null &&
  "available" in value &&
  typeof value.available === "boolean";

/** Local dictation: the switch, the speech model and what went wrong. Renders
 *  nothing, group included, for an account without the feature. */
export const DictationSetting = ({
  renderGroup,
}: {
  renderGroup: (content: React.JSX.Element) => React.JSX.Element;
}) => {
  const t = useTranslations("dictation");
  const locale = useLocale();
  const layout = useKeyboardLayout();
  const [snapshot, setSnapshot] = useState<DictationSnapshot | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_get_snapshot"),
      );
      if (disposed) {
        return;
      }
      setSnapshot(
        Result.isOk(result) && isDictationSnapshot(result.value)
          ? result.value
          : null,
      );
    };
    const stopListening = subscribeDesktopEvent({
      event: "dictation-changed",
      handler: () => {
        void refresh();
      },
      onError: () => {
        setSnapshot(null);
      },
    });
    void refresh();
    return () => {
      disposed = true;
      stopListening();
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

  return renderGroup(
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
    </div>,
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
