import { useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { useMountEffect } from "@stll/ui/effects";
import { useLayoutMeasurement } from "@stll/ui/effects-dom";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";

/** Mirrors `CHANGED_EVENT` in `dictation_preview.rs`; payload-free. */
const PREVIEW_CHANGED_EVENT = "dictation-preview-changed";

type PreviewStage = "hidden" | "listening" | "finishing";
type PreviewAnchor = "top" | "bottom";

type PreviewSnapshot = {
  stage: PreviewStage;
  text: string;
  anchor: PreviewAnchor;
};

const HIDDEN: PreviewSnapshot = { stage: "hidden", text: "", anchor: "top" };

const isPreviewSnapshot = (value: unknown): value is PreviewSnapshot =>
  typeof value === "object" &&
  value !== null &&
  "stage" in value &&
  (value.stage === "hidden" ||
    value.stage === "listening" ||
    value.stage === "finishing") &&
  "text" in value &&
  typeof value.text === "string" &&
  "anchor" in value &&
  (value.anchor === "top" || value.anchor === "bottom");

/** Fixed codes only: the panel never reports what it shows. */
const reportPreviewFailure = (code: "invokeFailed" | "invalidResponse") => {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES[code],
    operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
    window: DESKTOP_TELEMETRY_WINDOWS.main,
  });
};

/**
 * The running transcript under the status icon while the speaker holds the
 * dictation key. It only shows: the native side keeps the window from taking
 * focus or clicks, places it, and hides it once the dictation ends.
 */
const DictationPreviewApp = () => {
  const t = useTranslations("dictation.preview");
  const [snapshot, setSnapshot] = useState<PreviewSnapshot>(HIDDEN);

  useMountEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_preview_get_snapshot"),
      );
      if (disposed) {
        return;
      }
      if (Result.isError(result)) {
        reportPreviewFailure("invokeFailed");
        return;
      }
      if (!isPreviewSnapshot(result.value)) {
        reportPreviewFailure("invalidResponse");
        return;
      }
      setSnapshot(result.value);
    };
    const stopListening = subscribeDesktopEvent({
      event: PREVIEW_CHANGED_EVENT,
      handler: () => {
        void refresh();
      },
      onError: () => {
        reportPreviewFailure("invokeFailed");
      },
      // Read again once the listener is live: a change emitted before then
      // is in the snapshot.
      onSubscribed: () => {
        void refresh();
      },
    });
    void refresh();
    return () => {
      disposed = true;
      stopListening();
    };
  });

  // The top edge fades only once older lines have left it. Measured before
  // paint whenever the text changes or the box resizes.
  const [textBox, setTextBox] = useState<HTMLDivElement | null>(null);
  const overflowing = useLayoutMeasurement(
    textBox,
    linesOverflow,
    [snapshot.text],
    false,
  );

  const visible = snapshot.stage !== "hidden" && snapshot.text !== "";
  return (
    <main
      className="dictation-preview-window flex h-dvh justify-center p-2"
      data-anchor={snapshot.anchor}
    >
      {visible ? (
        <section
          aria-label={t("label")}
          aria-live="polite"
          className="bg-background/95 text-foreground w-full rounded-xl border px-3 py-2 shadow-lg backdrop-blur"
        >
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <span
              aria-hidden="true"
              className="dictation-preview-dot bg-destructive size-1.5 shrink-0 rounded-full"
              data-stage={snapshot.stage}
            />
            {snapshot.stage === "finishing" ? t("finishing") : t("listening")}
          </p>
          <div
            className="dictation-preview-text mt-1 text-sm leading-snug"
            data-overflowing={overflowing}
            ref={setTextBox}
          >
            <p>{snapshot.text}</p>
          </div>
        </section>
      ) : null}
    </main>
  );
};

/** Whether the text box's line runs taller than the box. */
const linesOverflow = (box: HTMLDivElement): boolean => {
  const line = box.firstElementChild;
  return line instanceof HTMLElement && line.offsetHeight > box.clientHeight;
};

export default DictationPreviewApp;
