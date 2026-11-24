import { useRef, useState } from "react";
import type { ReactElement } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DictateIcon, SquareIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import { composerText } from "@/components/chat-editor-source";
import type { ComposerContextMenuProps } from "@/components/chat/composer-plus-menu";
import { getLiveEditor } from "@/components/live-editor";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { useMountEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";

type Phase = "idle" | "acquiring" | "recording" | "transcribing";

type Recording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  timer: ReturnType<typeof setTimeout>;
};

const stopTracks = (stream: MediaStream) => {
  for (const track of stream.getTracks()) {
    track.stop();
  }
};

const release = ({ stream, timer }: Recording) => {
  clearTimeout(timer);
  stopTracks(stream);
};

const applyDictatedText = (
  controller: Pick<ChatEditorController, "editor" | "focus" | "setContent">,
  text: string,
) => {
  const liveEditor = getLiveEditor(controller.editor);
  if (liveEditor === null) {
    return;
  }
  if (liveEditor.isEmpty) {
    controller.setContent(composerText(text));
    controller.focus();
    return;
  }
  const separator = /\s$/u.test(liveEditor.getText()) ? "" : " ";
  liveEditor
    .chain()
    .focus("end")
    .insertContent({ type: "text", text: `${separator}${text}` })
    .run();
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
  controller: Pick<ChatEditorController, "editor" | "focus" | "setContent">;
  disabled: boolean;
  /** The guide's send step points at whichever control holds the slot. */
  guideAnchorsEnabled: boolean;
  /** A turn is running, so the slot is its stop button. */
  isGenerating: boolean;
}) => {
  const t = useTranslations();
  const [phase, setPhase] = useState<Phase>("idle");
  const recording = useRef<Recording | null>(null);
  const acquiring = useRef(false);
  const generation = useRef(0);

  // Leaving the composer drops any active recording and invalidates pending
  // microphone acquisition or transcription.
  useMountEffect(() => () => {
    generation.current += 1;
    acquiring.current = false;
    const dropped = recording.current;
    recording.current = null;
    if (dropped !== null) {
      dropped.recorder.stop();
      release(dropped);
    }
  });

  const transcribe = async (audio: Blob, runGeneration: number) => {
    const result = await Result.tryPromise(async () => {
      const { recordingToWav } =
        await import("@/components/chat/chat-dictation-audio");
      const file = await recordingToWav(audio);
      return await invokeCapability("dictation.transcribe", (request) =>
        api.dictation.transcribe.post(
          {
            file,
            ...(context?.threadRef.scope === "workspace"
              ? { matterId: context.threadRef.workspaceId }
              : {}),
          },
          request,
        ),
      );
    });
    if (runGeneration !== generation.current) {
      return;
    }
    setPhase("idle");
    if (Result.isError(result)) {
      notifyUserError(result.error, t("chat.dictationFailed"));
      return;
    }
    if (result.value.error) {
      notifyUserError(
        toAPIError(result.value.error),
        t("chat.dictationFailed"),
      );
      return;
    }
    const text = result.value.data.text.trim();
    if (text === "") {
      notifyUserProblem(t("chat.dictationSilent"));
      return;
    }
    applyDictatedText(controller, text);
  };

  const start = async () => {
    if (acquiring.current || recording.current !== null) {
      return;
    }
    acquiring.current = true;
    setPhase("acquiring");
    const runGeneration = generation.current;

    const streamResult = await Result.tryPromise(
      async () => await navigator.mediaDevices.getUserMedia({ audio: true }),
    );
    if (Result.isError(streamResult)) {
      acquiring.current = false;
      if (runGeneration === generation.current) {
        setPhase("idle");
        notifyUserProblem(t("chat.dictationDenied"));
      }
      return;
    }

    const stream = streamResult.value;
    if (runGeneration !== generation.current) {
      acquiring.current = false;
      stopTracks(stream);
      return;
    }

    const audioModuleResult = await Result.tryPromise(
      async () => await import("@/components/chat/chat-dictation-audio"),
    );
    acquiring.current = false;
    if (Result.isError(audioModuleResult)) {
      stopTracks(stream);
      if (runGeneration === generation.current) {
        setPhase("idle");
        notifyUserError(audioModuleResult.error, t("chat.dictationFailed"));
      }
      return;
    }
    if (runGeneration !== generation.current) {
      stopTracks(stream);
      return;
    }
    const { DICTATION_MAX_MS } = audioModuleResult.value;

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
        transcribe(
          new Blob(chunks, { type: recorder.mimeType }),
          runGeneration,
        ),
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
