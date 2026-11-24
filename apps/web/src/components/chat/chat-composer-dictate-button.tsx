import { useRef, useState } from "react";
import type { ReactElement } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DictateIcon, SquareIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import { composerText } from "@/components/chat-editor-source";
import {
  DICTATION_MAX_MS,
  recordingToWav,
} from "@/components/chat/chat-dictation-audio";
import type { ComposerContextMenuProps } from "@/components/chat/composer-plus-menu";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { useMountEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";

type Phase = "idle" | "recording" | "transcribing";

type Recording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  timer: ReturnType<typeof setTimeout>;
};

const release = ({ stream, timer }: Recording) => {
  clearTimeout(timer);
  for (const track of stream.getTracks()) {
    track.stop();
  }
};

/**
 * The microphone an empty composer shows in place of send (`children`):
 * press to dictate, press again to transcribe into the draft. It stays while
 * a dictation is under way, and a recording stops itself at the
 * transcription route's limit.
 */
export const ChatComposerDictateButton = ({
  blank,
  children,
  context,
  controller,
  disabled,
  guideAnchorsEnabled,
  isGenerating,
}: {
  /** Nothing to send. */
  blank: boolean;
  children: ReactElement;
  /** A matter chat's names help the transcription. */
  context: Pick<ComposerContextMenuProps, "threadRef"> | undefined;
  controller: Pick<ChatEditorController, "focus" | "setContent">;
  disabled: boolean;
  /** The guide's send step points at whichever control holds the slot. */
  guideAnchorsEnabled: boolean;
  /** A turn is running, so the slot is its stop button. */
  isGenerating: boolean;
}) => {
  const t = useTranslations();
  const [phase, setPhase] = useState<Phase>("idle");
  const recording = useRef<Recording | null>(null);

  // Leaving the composer drops the recording instead of transcribing it.
  useMountEffect(() => () => {
    const dropped = recording.current;
    recording.current = null;
    if (dropped !== null) {
      dropped.recorder.stop();
      release(dropped);
    }
  });

  const transcribe = async (audio: Blob) => {
    try {
      const file = await recordingToWav(audio);
      const response = await api.dictation.transcribe.post({
        file,
        ...(context?.threadRef.scope === "workspace"
          ? { matterId: context.threadRef.workspaceId }
          : {}),
      });
      if (response.error) {
        notifyUserError(toAPIError(response.error), t("chat.dictationFailed"));
        return;
      }
      const text = response.data.text.trim();
      if (text === "") {
        notifyUserProblem(t("chat.dictationSilent"));
        return;
      }
      controller.setContent(composerText(text));
      controller.focus();
    } catch (error) {
      notifyUserError(error, t("chat.dictationFailed"));
    } finally {
      setPhase("idle");
    }
  };

  const start = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      notifyUserProblem(t("chat.dictationDenied"));
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (recording.current?.recorder !== recorder) {
        return;
      }
      release(recording.current);
      recording.current = null;
      setPhase("transcribing");
      detached(
        transcribe(new Blob(chunks, { type: recorder.mimeType })),
        "chat-composer-dictate-button.transcribe",
      );
    };
    recording.current = {
      recorder,
      stream,
      timer: setTimeout(() => {
        recorder.stop();
      }, DICTATION_MAX_MS),
    };
    recorder.start();
    setPhase("recording");
  };

  if ((!blank || isGenerating) && phase === "idle") {
    return children;
  }

  const label = {
    idle: t("chat.dictate"),
    recording: t("chat.dictationFinish"),
    transcribing: t("chat.dictationTranscribing"),
  }[phase];

  return (
    <Button
      {...guideAnchor(GUIDE_ANCHORS.chatSend, guideAnchorsEnabled)}
      aria-busy={phase === "transcribing" ? true : undefined}
      aria-label={label}
      disabled={phase === "transcribing" || (disabled && phase === "idle")}
      disabledReason={label}
      onClick={() => {
        if (phase === "recording") {
          recording.current?.recorder.stop();
          return;
        }
        detached(start(), "chat-composer-dictate-button.start");
      }}
      size="icon-round"
      tooltip={phase === "idle" ? undefined : false}
      type="button"
      variant="composer"
    >
      {phase === "idle" && (
        <DictateIcon aria-hidden="true" className="size-3.5" />
      )}
      {phase === "recording" && (
        <SquareIcon aria-hidden="true" className="text-destructive size-3.5" />
      )}
      {phase === "transcribing" && (
        <Loader className="size-3.5" label={label} size="sm" />
      )}
    </Button>
  );
};
