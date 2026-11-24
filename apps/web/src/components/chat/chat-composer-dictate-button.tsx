import { useRef, useState } from "react";
import type { ReactElement } from "react";

import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DictateIcon, SquareIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import type { DictationRecording } from "@/components/chat/chat-dictation-audio";
import type { ComposerContextMenuProps } from "@/components/chat/composer-plus-menu";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { useMountEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";

type Phase = "idle" | "acquiring" | "recording" | "transcribing";

type ActiveSession = {
  recording: DictationRecording;
  release: (recording: DictationRecording) => void;
};

const loadDictationAudio = async () =>
  await import("@/components/chat/chat-dictation-audio");

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
  controller: Pick<ChatEditorController, "editor" | "focus" | "setContent">;
  disabled: boolean;
  /** The guide's send step points at whichever control holds the slot. */
  guideAnchorsEnabled: boolean;
  /** A turn is running, so the slot is its stop button. */
  isGenerating: boolean;
}) => {
  const t = useTranslations();
  const [phase, setPhase] = useState<Phase>("idle");
  const activeSession = useRef<ActiveSession | null>(null);
  const acquiring = useRef(false);
  const generation = useRef(0);

  // Leaving the composer or switching threads drops any active recording and
  // invalidates pending microphone acquisition or transcription.
  useMountEffect(() => () => {
    generation.current += 1;
    acquiring.current = false;
    const dropped = activeSession.current;
    activeSession.current = null;
    if (dropped !== null) {
      dropped.recording.recorder.stop();
      dropped.release(dropped.recording);
    }
  });

  const start = async () => {
    if (acquiring.current || activeSession.current !== null) {
      return;
    }
    acquiring.current = true;
    setPhase("acquiring");
    const runGeneration = generation.current;

    const moduleResult = await Result.tryPromise(loadDictationAudio);
    if (Result.isError(moduleResult)) {
      acquiring.current = false;
      if (runGeneration === generation.current) {
        setPhase("idle");
        notifyUserError(moduleResult.error, t("chat.dictationFailed"));
      }
      return;
    }
    const {
      acquireAndStartRecording,
      applyDictatedText,
      releaseDictationRecording,
      transcribeDictationAudio,
    } = moduleResult.value;

    const transcribe = async (audio: Blob) => {
      const outcome = await transcribeDictationAudio({ audio, context });
      if (runGeneration !== generation.current) {
        return;
      }
      setPhase("idle");
      switch (outcome.type) {
        case "text":
          applyDictatedText(controller, outcome.text);
          return;
        case "silent":
          notifyUserProblem(t("chat.dictationSilent"));
          return;
        case "error":
          notifyUserError(outcome.error, t("chat.dictationFailed"));
          return;
        default:
          outcome satisfies never;
          panic(`Unhandled dictation transcribe outcome`);
      }
    };

    const outcome = await acquireAndStartRecording({
      isStillValid: () => runGeneration === generation.current,
      onStop: (audio, recorder) => {
        if (activeSession.current?.recording.recorder !== recorder) {
          return;
        }
        activeSession.current.release(activeSession.current.recording);
        activeSession.current = null;
        setPhase("transcribing");
        detached(transcribe(audio), "chat-composer-dictate-button.transcribe");
      },
    });
    acquiring.current = false;

    switch (outcome.type) {
      case "started":
        activeSession.current = {
          recording: outcome.recording,
          release: releaseDictationRecording,
        };
        setPhase("recording");
        return;
      case "denied":
        setPhase("idle");
        notifyUserProblem(t("chat.dictationDenied"));
        return;
      case "cancelled":
        return;
      case "error":
        if (runGeneration === generation.current) {
          setPhase("idle");
          notifyUserError(outcome.error, t("chat.dictationFailed"));
        }
        return;
      default:
        outcome satisfies never;
        panic(`Unhandled dictation start outcome`);
    }
  };

  if ((!blank || isGenerating) && phase === "idle") {
    return children;
  }

  const label = {
    idle: t("chat.dictate"),
    acquiring: t("chat.dictate"),
    recording: t("chat.dictationFinish"),
    transcribing: t("chat.dictationTranscribing"),
  }[phase];

  const dictateButton = (
    <Button
      {...guideAnchor(
        GUIDE_ANCHORS.chatSend,
        guideAnchorsEnabled && !isGenerating,
      )}
      aria-busy={phase === "transcribing" ? true : undefined}
      aria-label={label}
      disabled={
        phase === "acquiring" ||
        phase === "transcribing" ||
        (disabled && phase === "idle")
      }
      disabledReason={label}
      onClick={() => {
        if (phase === "recording") {
          activeSession.current?.recording.recorder.stop();
          return;
        }
        detached(start(), "chat-composer-dictate-button.start");
      }}
      size="icon-round"
      tooltip={phase === "idle" ? undefined : false}
      type="button"
      variant="composer"
    >
      {(phase === "idle" || phase === "acquiring") && (
        <DictateIcon aria-hidden="true" className="size-3.5" />
      )}
      {phase === "recording" && (
        <SquareIcon aria-hidden="true" className="size-3.5" />
      )}
      {phase === "transcribing" && (
        <Loader className="size-3.5" label={label} size="sm" />
      )}
    </Button>
  );

  // Keep the turn stop control reachable when generation starts during dictation.
  if (isGenerating) {
    return (
      <>
        {dictateButton}
        {children}
      </>
    );
  }

  return dictateButton;
};
