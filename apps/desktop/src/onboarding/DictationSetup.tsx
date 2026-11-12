import { panic } from "better-result";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CheckCircle2Icon } from "@stll/ui/icons";
import { Textarea } from "@stll/ui/textarea";

import { PermissionsSection } from "../mainview/PermissionsSection";
import { Keycaps } from "../shared/Keycaps";
import type { Permission } from "../shared/permissions";
import { formatShortcut, shortcutKeycaps } from "../shared/shortcut-keys";
import {
  DESKTOP_PLATFORM,
  useKeyboardLayout,
} from "../shared/use-clipboard-shortcut";
import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import type { DictationControls, DictationSnapshot } from "./use-dictation";

const BYTES_PER_MEGABYTE = 1000000;
const PERCENT = 100;

type DictationSetupProps = {
  controls: DictationControls;
  /** The permissions dictation needs here, asked once it is on. */
  permissions: readonly Permission[];
};

/**
 * Dictation explained in a line, then turned on where it is explained: the
 * switch and the speech model download in one action, the permissions it
 * needs, and a field to dictate into once the model is ready.
 */
export const DictationSetup = ({
  controls,
  permissions,
}: DictationSetupProps) => {
  const t = useTranslations("onboarding");
  const dictationT = useTranslations("dictation");
  const locale = useLocale();
  const layout = useKeyboardLayout();
  const { snapshot } = controls;

  if (snapshot === null || !snapshot.available) {
    return null;
  }

  const keys = { keys: snapshot.keys, layout, locale };
  const shortcut = formatShortcut({ ...keys, platform: DESKTOP_PLATFORM });
  const ready = snapshot.enabled && snapshot.model.status === "ready";

  return (
    <>
      <p className="text-muted-foreground mt-1 max-w-md text-sm leading-relaxed text-pretty">
        {dictationT("description", { shortcut })}
      </p>
      <div className="mt-4 flex flex-col gap-3">
        {ready ? null : (
          <div className="bg-card overflow-hidden rounded-xl border">
            <ModelRow controls={controls} snapshot={snapshot} />
          </div>
        )}
        {snapshot.enabled ? (
          <div className="bg-card overflow-hidden rounded-xl border empty:hidden">
            <PermissionsSection
              descriptions={{
                accessibility: t("dictationAccessibility"),
                microphone: t("dictationMicrophone"),
              }}
              only={permissions}
              window={DESKTOP_TELEMETRY_WINDOWS.onboarding}
            />
          </div>
        ) : null}
        {ready ? (
          <div className="flex flex-col gap-2 rounded-xl border border-dashed p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <CheckCircle2Icon
                  aria-hidden="true"
                  className="text-success-foreground size-4 shrink-0"
                />
                {t("dictationReady")}
              </p>
              <Keycaps
                caps={shortcutKeycaps({
                  ...keys,
                  platform: DESKTOP_PLATFORM,
                }).map((cap) => ({
                  ...cap,
                  state: snapshot.phase === "recording" ? "down" : "idle",
                }))}
              />
            </div>
            <Textarea
              aria-label={t("dictationTryLabel")}
              className="resize-none"
              placeholder={t("dictationTryPlaceholder", { shortcut })}
              rows={2}
            />
            <p
              aria-live="polite"
              className="text-muted-foreground min-h-4 text-xs"
            >
              {phaseMessage(snapshot.phase, t)}
            </p>
          </div>
        ) : null}
        {snapshot.shortcutTaken ? (
          <p className="text-destructive-foreground text-sm">
            {dictationT("shortcutTaken", { shortcut })}
          </p>
        ) : null}
        {snapshot.failure === null ? null : (
          <p className="text-destructive-foreground text-sm" role="status">
            {dictationT(`failure.${snapshot.failure}`)}
          </p>
        )}
        {controls.failed ? (
          <p className="text-destructive-foreground text-sm" role="alert">
            {t("dictationFailed")}
          </p>
        ) : null}
      </div>
    </>
  );
};

function phaseMessage(
  phase: DictationSnapshot["phase"],
  t: ReturnType<typeof useTranslations<"onboarding">>,
) {
  switch (phase) {
    case "idle":
      return null;
    case "recording":
      return t("dictationListening");
    case "transcribing":
      return t("dictationTranscribing");
    default:
      phase satisfies never;
      return panic("Unknown dictation phase.");
  }
}

/** Off, or on while the speech model is missing or on its way. */
const ModelRow = ({
  controls,
  snapshot,
}: {
  controls: DictationControls;
  snapshot: DictationSnapshot;
}) => {
  const t = useTranslations("onboarding");
  const dictationT = useTranslations("dictation");
  const size = Math.round(snapshot.modelBytes / BYTES_PER_MEGABYTE);
  const { model } = snapshot;

  if (!snapshot.enabled) {
    return (
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <p className="text-muted-foreground min-w-0 flex-1 text-sm leading-relaxed">
          {t("dictationModel", { size })}
        </p>
        <Button
          className="shrink-0"
          onClick={() => {
            void controls.turnOn();
          }}
        >
          {t("dictationTurnOn")}
        </Button>
      </div>
    );
  }
  if (model.status === "downloading") {
    const percent = Math.floor((model.received / model.total) * PERCENT);
    return (
      <div className="flex flex-col gap-2 px-4 py-3">
        <p className="text-sm tabular-nums" role="status">
          {dictationT("downloading", { percent })}
        </p>
        <div
          aria-hidden="true"
          className="bg-muted h-1.5 overflow-hidden rounded-full"
        >
          <div
            className="bg-foreground h-full rounded-full"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          {t("dictationDownloadContinues")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <p className="text-muted-foreground min-w-0 flex-1 text-sm">
        {model.status === "failed"
          ? dictationT("downloadFailed")
          : dictationT("modelNeeded")}
      </p>
      <Button
        className="shrink-0"
        onClick={() => {
          void controls.download();
        }}
        variant="outline"
      >
        {dictationT("download", { size })}
      </Button>
    </div>
  );
};
