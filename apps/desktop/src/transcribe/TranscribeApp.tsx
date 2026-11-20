import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import type { DesktopMatter } from "@stll/api-contract/desktop-time-entries";
import { Button } from "@stll/ui/button";
import { InfoIcon, TriangleAlertIcon, WavesIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@stll/ui/toggle-group";
import { TruncatedText } from "@stll/ui/truncated-text";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import { detectDesktopPlatform } from "../shared/shortcut-keys";
import { WindowDragRegion } from "../shared/WindowDragRegion";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import {
  blocksToHtml,
  blocksToText,
  cleanedMarkdown,
  escapeHtmlText,
  paragraphsToHtml,
} from "./cleaned-text";
import {
  afterRefusedStart,
  formatTimestamp,
  isFileChoice,
  isFinished,
  isPieceText,
  isShownModel,
  isTranscribeSnapshot,
  paragraphsOf,
  progressShare,
  recordingTitle,
  TRANSCRIBE_FILE_EVENT,
  TRANSCRIBE_FINISHED_EVENT,
  TRANSCRIBE_PIECE_EVENT,
  transcriptText,
  wholeMinutes,
} from "./transcribe-logic";
import type {
  FileChoice,
  Finished,
  PieceText,
  RecordingModel,
  RefusedReason,
  ShownModel,
  Started,
  TranscribeDestination,
  TranscribeFailure,
  TranscribeSnapshot,
} from "./transcribe-logic";
import {
  CleanedText,
  CleanupOffer,
  PaneActions,
  useCopyFormat,
  useRecordingCleanup,
} from "./TranscribeCleanup";
import { TranscribeMatterPicker } from "./TranscribeMatterPicker";

const MAC = detectDesktopPlatform(navigator.userAgent) === "mac";

type ReadyFile = Extract<FileChoice, { status: "ready" }>;

type Session = {
  job: number;
  file: ReadyFile;
  model: RecordingModel | null;
  matter: DesktopMatter | null;
  /** Cleanup starts on its own; otherwise the speaker asks for it. */
  autoCleanup: boolean;
};

type Saving =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; fileName: string }
  | { status: "failed" };

/** The "Transcribe a recording" window: choose a file, then read its text
 *  as it is transcribed, and copy or save it. */
const TranscribeApp = () => {
  const [snapshot, setSnapshot] = useState<TranscribeSnapshot | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [model, setModel] = useState<ModelState>(MODEL_LOADING);
  const [destination, setDestination] =
    useState<TranscribeDestination>("local");
  const [matter, setMatter] = useState<DesktopMatter | null>(null);
  const [refused, setRefused] = useState<RefusedFile | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  // A file that waits for the user to start it with stella AI, once the
  // model it goes to, and any warning about it, is shown again.
  const [kept, setKept] = useState<ReadyFile | null>(null);
  const startFile = useRef<((file: ReadyFile) => Promise<void>) | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [pieces, setPieces] = useState<PieceText[]>([]);
  const [finished, setFinished] = useState<Finished[]>([]);
  // What the next chosen file starts with, read by the event handler
  // without resubscribing; written where the choices change.
  const options = useRef<StartOptions>({
    destination: "local",
    matter: null,
    snapshot: null,
    model: MODEL_LOADING,
  });
  const chooseDestination = (next: TranscribeDestination) => {
    options.current.destination = next;
    setDestination(next);
  };
  const chooseMatter = (next: DesktopMatter | null) => {
    options.current.matter = next;
    setMatter(next);
  };

  // Reads what the window can offer; a read that fails offers to try again.
  // Each read returns what cancels it.
  const loadSnapshot = useCallback(() => {
    let disposed = false;
    // A named function, not one invoked in place: an inline call is read as
    // running before the cleanup below can ever set `disposed`.
    const load = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("transcribe_get_snapshot"),
      );
      if (disposed) {
        return;
      }
      if (Result.isOk(result) && isTranscribeSnapshot(result.value)) {
        // A window that starts afresh shows no transcript, so native code
        // holds none either: a newly chosen file is taken.
        if (result.value.running === null) {
          void invoke("transcribe_clear_file").catch(() => undefined);
        }
        options.current.destination = result.value.destination;
        options.current.snapshot = result.value;
        setSnapshot(result.value);
        setDestination(result.value.destination);
        return;
      }
      report(DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed);
      setLoadFailed(true);
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => loadSnapshot(), [loadSnapshot]);

  // The model a recording would go to, read before a file can be chosen
  // for stella AI: the window shows it, with its warning where its provider
  // keeps the audio, and a start names it back.
  const loadModel = useCallback(() => {
    let disposed = false;
    const load = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("transcribe_get_model"),
      );
      if (disposed) {
        return;
      }
      const next: ModelState =
        Result.isOk(result) && isShownModel(result.value)
          ? { status: "ready", model: result.value }
          : { status: "failed" };
      options.current.model = next;
      setModel(next);
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);
  const reloadModel = useCallback(() => {
    options.current.model = MODEL_LOADING;
    setModel(MODEL_LOADING);
    loadModel();
  }, [loadModel]);
  const cloudAvailable = snapshot?.cloudAvailable === true;
  useEffect(
    () => (cloudAvailable ? loadModel() : undefined),
    [cloudAvailable, loadModel],
  );

  useEffect(() => {
    let starting = false;
    // A file announced while another start is on its way; native code
    // starts only the one it holds, so the newest is tried next.
    let waiting: ReadyFile | null = null;
    const start = async (file: ReadyFile) => {
      if (starting) {
        waiting = file;
        return;
      }
      const chosen = { ...options.current };
      setRefused(null);
      setKept(null);
      const usable = usableFor(chosen);
      // A file for stella AI before its model is shown waits for the user.
      const awaitsModel =
        !usable &&
        chosen.destination === "cloud" &&
        chosen.snapshot?.cloudAvailable === true;
      setStartFailed(!usable && !awaitsModel);
      if (awaitsModel) {
        setKept(file);
      }
      if (!usable) {
        return;
      }
      starting = true;
      const result = await Result.tryPromise(async () =>
        invoke<Started>("transcribe_start", {
          request: {
            destination: chosen.destination,
            matterId: chosen.matter?.id ?? null,
            selection: file.selection,
            modelTicket:
              chosen.destination === "cloud" && chosen.model.status === "ready"
                ? chosen.model.model.ticket
                : null,
          },
        }),
      );
      starting = false;
      const next = waiting;
      waiting = null;
      if (Result.isError(result)) {
        setStartFailed(true);
        // The model or its account may have changed since the window read
        // it: read it again, so its warning shows before a file is started.
        if (chosen.destination === "cloud") {
          reloadModel();
        }
        const { startNow, keep } = afterRefusedStart({
          destination: chosen.destination,
          refused: file,
          waiting: next,
        });
        setKept(keep);
        if (startNow !== null) {
          void start(startNow);
        }
        return;
      }
      setSession({
        job: result.value.job,
        file,
        model: result.value.model,
        matter: chosen.matter,
        autoCleanup: result.value.autoCleanup === true,
      });
    };
    startFile.current = start;
    const onError = () =>
      report(DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed);
    const stopFile = subscribeDesktopEvent<unknown>({
      event: TRANSCRIBE_FILE_EVENT,
      handler: ({ payload }) => {
        if (!isFileChoice(payload)) {
          return;
        }
        if (payload.status === "refused") {
          setStartFailed(false);
          setRefused(payload);
          return;
        }
        void start(payload);
      },
      onError,
    });
    const stopPiece = subscribeDesktopEvent<unknown>({
      event: TRANSCRIBE_PIECE_EVENT,
      handler: ({ payload }) => {
        if (isPieceText(payload)) {
          setPieces((current) => [...current, payload]);
        }
      },
      onError,
    });
    const stopFinished = subscribeDesktopEvent<unknown>({
      event: TRANSCRIBE_FINISHED_EVENT,
      handler: ({ payload }) => {
        if (isFinished(payload)) {
          setFinished((current) => [...current, payload]);
        }
      },
      onError,
    });
    return () => {
      startFile.current = null;
      stopFile();
      stopPiece();
      stopFinished();
    };
  }, [reloadModel]);

  if (snapshot === null) {
    return loadFailed ? (
      <LoadFailed
        onRetry={() => {
          setLoadFailed(false);
          loadSnapshot();
        }}
      />
    ) : (
      <main className="bg-background min-h-dvh" />
    );
  }
  if (session === null) {
    return (
      <ChooseScreen
        destination={destination}
        kept={kept}
        matter={matter}
        model={model}
        onStartKept={(file) => {
          void startFile.current?.(file);
        }}
        onDestinationChange={chooseDestination}
        onMatterChange={chooseMatter}
        onRetryModel={reloadModel}
        refused={refused}
        snapshot={snapshot}
        startFailed={startFailed}
      />
    );
  }
  const outcome = finished.find((entry) => entry.job === session.job) ?? null;
  return (
    <ResultScreen
      key={session.job}
      onAnother={() => {
        setSession(null);
        setPieces([]);
        setFinished([]);
        void invoke("transcribe_clear_file").catch(() => undefined);
      }}
      outcome={outcome}
      pieces={pieces.filter((piece) => piece.job === session.job)}
      session={session}
    />
  );
};

export default TranscribeApp;

type RefusedFile = Extract<FileChoice, { status: "refused" }>;

/** The stella AI model, as far as the window has read it. */
type ModelState =
  | { status: "loading" }
  | { status: "ready"; model: ShownModel }
  | { status: "failed" };

const MODEL_LOADING: ModelState = { status: "loading" };

type StartOptions = {
  destination: TranscribeDestination;
  matter: DesktopMatter | null;
  snapshot: TranscribeSnapshot | null;
  model: ModelState;
};

/** Whether a file chosen now can be transcribed where the window says: on
 *  this computer once its model is there, with stella AI once the model a
 *  recording goes to, and any warning about it, is shown. */
const usableFor = ({
  snapshot,
  destination,
  model,
}: Omit<StartOptions, "matter">): boolean =>
  snapshot !== null &&
  (destination === "local"
    ? snapshot.localReady
    : snapshot.cloudAvailable && model.status === "ready");

const report = (
  code:
    | typeof DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed
    | typeof DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
) => {
  reportDesktopError({
    code,
    operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
    window: DESKTOP_TELEMETRY_WINDOWS.transcribe,
  });
};

const WindowBar = () => {
  const t = useTranslations("transcribe");
  return (
    <header
      className={
        MAC
          ? "flex h-11 shrink-0 items-center border-b ps-20 pe-4"
          : "flex h-11 shrink-0 items-center border-b px-4"
      }
    >
      <h1 className="text-sm font-semibold">{t("title")}</h1>
    </header>
  );
};

const Shell = ({ children }: React.PropsWithChildren) => (
  <main className="bg-background text-foreground flex h-dvh flex-col">
    <WindowDragRegion />
    <WindowBar />
    {children}
  </main>
);

/** What the window shows when it could not read what it can offer. */
const LoadFailed = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations("transcribe");
  return (
    <Shell>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-7 py-6 text-center">
        <p
          className="text-destructive max-w-md text-sm text-pretty"
          role="alert"
        >
          {t("failure.load")}
        </p>
        <Button onClick={onRetry} size="sm" variant="outline">
          {t("retry")}
        </Button>
      </div>
    </Shell>
  );
};

const RecordingTile = ({ size }: { size: "large" | "small" }) => (
  <div
    aria-hidden="true"
    className={
      size === "large"
        ? "bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-xl"
        : "bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg"
    }
  >
    <WavesIcon className={size === "large" ? "size-5" : "size-4"} />
  </div>
);

const REFUSED_MESSAGES = {
  dictaphone: "note",
  unsupported: "refused.unsupported",
  tooLong: "refused.tooLong",
  unreadable: "refused.unreadable",
} as const satisfies Record<RefusedReason, string>;

const ChooseScreen = ({
  snapshot,
  destination,
  onDestinationChange,
  matter,
  onMatterChange,
  model,
  onRetryModel,
  kept,
  onStartKept,
  refused,
  startFailed,
}: {
  snapshot: TranscribeSnapshot;
  destination: TranscribeDestination;
  onDestinationChange: (destination: TranscribeDestination) => void;
  matter: DesktopMatter | null;
  onMatterChange: (matter: DesktopMatter | null) => void;
  model: ModelState;
  onRetryModel: () => void;
  kept: ReadyFile | null;
  onStartKept: (file: ReadyFile) => void;
  refused: RefusedFile | null;
  startFailed: boolean;
}) => {
  const t = useTranslations("transcribe");
  const [dragging, setDragging] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [chooseFailed, setChooseFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        setDragging(payload.type === "enter" || payload.type === "over");
      })
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
        return undefined;
      })
      .catch(() =>
        report(DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  const usable = usableFor({ snapshot, destination, model });
  const choose = async () => {
    setChoosing(true);
    setChooseFailed(false);
    const result = await Result.tryPromise(async () =>
      invoke<unknown>("transcribe_choose_file"),
    );
    setChoosing(false);
    if (Result.isError(result)) {
      setChooseFailed(true);
    }
  };
  return (
    <Shell>
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-7 py-6">
        <section
          aria-label={t("drop.title")}
          className={
            dragging
              ? "border-foreground-disabled bg-muted/60 flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 text-center"
              : "border-border bg-muted/20 flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 text-center"
          }
        >
          <RecordingTile size="large" />
          <p className="text-base font-semibold text-balance">
            {dragging ? t("drop.release") : t("drop.title")}
          </p>
          <p className="text-muted-foreground max-w-md text-xs text-pretty">
            {t("drop.description")}
          </p>
          <Button
            disabled={!usable || choosing}
            onClick={() => {
              void choose();
            }}
            size="sm"
          >
            {t("drop.choose")}
          </Button>
          <p className="text-muted-foreground max-w-md text-xs text-pretty">
            {MAC ? t("drop.formatsMac") : t("drop.formats")}
          </p>
          {refused === null ? null : (
            <p
              className="text-destructive max-w-md text-xs text-pretty"
              role="alert"
            >
              {t(REFUSED_MESSAGES[refused.reason], { name: refused.name })}
            </p>
          )}
          {kept === null ? null : (
            <div className="flex max-w-md flex-col items-center gap-2">
              <p className="text-foreground-strong-muted text-xs text-pretty">
                {t("kept.ready", { name: kept.name })}
              </p>
              <Button
                disabled={!usable}
                onClick={() => {
                  onStartKept(kept);
                }}
                size="sm"
                variant="outline"
              >
                {t("kept.start")}
              </Button>
            </div>
          )}
          {startFailed || chooseFailed ? (
            <p className="text-destructive max-w-md text-xs" role="alert">
              {t("failure.start")}
            </p>
          ) : null}
        </section>
        <div className="bg-card divide-y overflow-hidden rounded-xl border">
          <div className="flex min-h-12 items-center gap-3 px-4 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("destination.title")}</p>
              <DestinationNote
                cloudAvailable={snapshot.cloudAvailable}
                destination={destination}
                localReady={snapshot.localReady}
                model={model}
                onRetryModel={onRetryModel}
              />
            </div>
            <ToggleGroup<TranscribeDestination>
              aria-label={t("destination.title")}
              onValueChange={(value) => {
                const next = value.at(0);
                if (next !== undefined) {
                  onDestinationChange(next);
                }
              }}
              size="sm"
              value={[destination]}
            >
              <ToggleGroupItem<TranscribeDestination> value="local">
                {t("destination.thisComputer")}
              </ToggleGroupItem>
              {snapshot.cloudAvailable ? (
                <ToggleGroupItem<TranscribeDestination> value="cloud">
                  {t("destination.cloud")}
                </ToggleGroupItem>
              ) : null}
            </ToggleGroup>
          </div>
          <div className="flex min-h-12 items-center gap-3 px-4 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("matter.title")}</p>
              <p className="text-muted-foreground text-xs text-pretty">
                {t("matter.description")}
              </p>
            </div>
            <TranscribeMatterPicker matter={matter} onChange={onMatterChange} />
          </div>
        </div>
        <p className="text-muted-foreground flex gap-2 px-0.5 text-xs text-pretty">
          <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("note")}</span>
        </p>
      </div>
    </Shell>
  );
};

/** What the chosen destination needs, in one quiet line. */
const DestinationNote = ({
  destination,
  localReady,
  cloudAvailable,
  model,
  onRetryModel,
}: {
  destination: TranscribeDestination;
  localReady: boolean;
  cloudAvailable: boolean;
  model: ModelState;
  onRetryModel: () => void;
}) => {
  const t = useTranslations("transcribe");
  if (destination === "local" && !localReady) {
    return (
      <p className="text-muted-foreground text-xs text-pretty">
        {cloudAvailable
          ? t("destination.localMissingCloud")
          : t("destination.localMissing")}
      </p>
    );
  }
  if (destination === "local") {
    return (
      <p className="text-muted-foreground text-xs text-pretty">
        {t("destination.localDescription")}
      </p>
    );
  }
  if (model.status === "failed") {
    return (
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-destructive text-xs text-pretty" role="alert">
          {t("destination.modelFailed")}
        </p>
        <Button onClick={onRetryModel} size="xs" variant="ghost">
          {t("retry")}
        </Button>
      </div>
    );
  }
  if (model.status === "loading") {
    return (
      <p className="text-muted-foreground text-xs text-pretty">
        {t("destination.cloudDescription")}
      </p>
    );
  }
  const { displayName, provider, retainsData } = model.model;
  return (
    <>
      <p className="text-muted-foreground text-xs text-pretty">
        {t("destination.cloudDescriptionModel", { model: displayName })}
      </p>
      {retainsData ? (
        <p className="text-destructive-foreground mt-1 flex gap-1.5 text-xs text-pretty">
          <TriangleAlertIcon
            aria-hidden="true"
            className="mt-px size-3.5 shrink-0"
          />
          {t("destination.retainsData", { provider: provider ?? displayName })}
        </p>
      ) : null}
    </>
  );
};

const FAILURE_MESSAGES = {
  modelMissing: "failure.modelMissing",
  local: "failure.thisComputer",
  cloud: "failure.cloud",
  unreadable: "failure.unreadable",
  tooLong: "failure.tooLong",
} as const satisfies Record<TranscribeFailure, string>;

const ResultScreen = ({
  session,
  pieces,
  outcome,
  onAnother,
}: {
  session: Session;
  pieces: readonly PieceText[];
  outcome: Finished | null;
  onAnother: () => void;
}) => {
  const t = useTranslations("transcribe");
  const [saving, setSaving] = useState<Saving>({ status: "idle" });
  const [actionFailed, setActionFailed] = useState(false);
  const paragraphs = paragraphsOf(pieces);
  let doneMs = 0;
  for (const piece of pieces) {
    doneMs = Math.max(doneMs, piece.endMs);
  }
  const running = outcome === null;
  const hasText = paragraphs.length > 0;
  const title = recordingTitle(session.file.name);
  const meta = [
    session.file.durationMs === null
      ? null
      : t("result.minutes", { minutes: wholeMinutes(session.file.durationMs) }),
    session.file.format,
    session.model === null
      ? t("result.thisComputer")
      : t("result.cloud", { model: session.model.displayName }),
    session.matter === null
      ? null
      : t("result.matter", { name: session.matter.name }),
  ].filter((part) => part !== null);
  const cleanup = useRecordingCleanup({
    job: session.job,
    paragraphs,
    finished: !running,
    autoStart: session.autoCleanup,
  });
  const [copyFormat, setCopyFormat] = useCopyFormat();
  const cleanedBlocks = cleanup.blocks;
  const cleanedReady = !cleanup.running && cleanup.parts.length > 0;
  const save = async (
    text: string,
    fileName: string,
    format: "text" | "markdown",
  ) => {
    setActionFailed(false);
    const result = await Result.tryPromise(async () =>
      invoke<boolean>("transcribe_save_text", {
        request: { text, fileName, format },
      }),
    );
    if (Result.isError(result)) {
      setActionFailed(true);
    }
  };
  const copy = async (text: string, html: string | null) => {
    const result = await Result.tryPromise(async () =>
      html === null
        ? invoke("transcribe_copy_text", { text })
        : invoke("transcribe_copy_rich", { text, html }),
    );
    setActionFailed(Result.isError(result));
    return Result.isOk(result);
  };
  let cleanedStatus = "";
  if (cleanup.running && hasText) {
    cleanedStatus = t("cleaned.running");
  } else if (cleanup.failed > 0) {
    cleanedStatus = t("cleaned.failedCount", { count: cleanup.failed });
  }
  const instructionsLabel = t("cleaned.instructionsLabel");
  const cleanedPlain = [
    ...(cleanup.instructions.length > 0
      ? [`${instructionsLabel} ${cleanup.instructions.join(" ")}`]
      : []),
    blocksToText(cleanedBlocks),
  ].join("\n\n");
  const cleanedHtml = [
    ...(cleanup.instructions.length > 0
      ? [
          `<p><em>${escapeHtmlText(`${instructionsLabel} ${cleanup.instructions.join(" ")}`)}</em></p>`,
        ]
      : []),
    blocksToHtml(cleanedBlocks),
  ].join("\n");
  const saveToMatter = async () => {
    if (session.matter === null) {
      return;
    }
    setSaving({ status: "saving" });
    const result = await Result.tryPromise(async () =>
      invoke<{ fileName: string }>("transcribe_save_to_matter", {
        request: {
          matterId: session.matter?.id,
          title: t("result.documentTitle", { title }),
          paragraphs,
        },
      }),
    );
    setSaving(
      Result.isOk(result)
        ? { status: "saved", fileName: result.value.fileName }
        : { status: "failed" },
    );
  };
  return (
    <Shell>
      <div className="flex shrink-0 items-center gap-3 border-b px-7 py-4">
        <RecordingTile size="small" />
        <div className="min-w-0 flex-1">
          <TruncatedText className="text-sm font-semibold" render={<bdi />}>
            {session.file.name}
          </TruncatedText>
          <TruncatedText
            className="text-muted-foreground mt-0.5 text-xs"
            render={<p />}
          >
            {meta.join(" · ")}
          </TruncatedText>
        </div>
        {session.matter === null ? null : (
          <Button
            disabled={
              !hasText ||
              running ||
              saving.status === "saving" ||
              saving.status === "saved"
            }
            onClick={() => {
              void saveToMatter();
            }}
            size="sm"
          >
            {saving.status === "saving"
              ? t("result.savingToMatter")
              : t("result.saveToMatter")}
          </Button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2">
        <section
          aria-labelledby="transcribe-raw-title"
          className="flex min-h-0 flex-col border-e"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b ps-7 pe-4">
            <h2
              className="flex-1 text-sm font-semibold"
              id="transcribe-raw-title"
            >
              {t("result.transcriptTitle")}
            </h2>
            <PaneActions
              copyFormat={copyFormat}
              disabled={!hasText}
              onCopy={async (format) =>
                await copy(
                  transcriptText(paragraphs, { timestamps: true }),
                  format === "formatted"
                    ? paragraphsToHtml(paragraphs, formatTimestamp)
                    : null,
                )
              }
              onCopyFormatChange={setCopyFormat}
              saveOptions={[
                {
                  id: "timestamps",
                  label: t("result.saveWithTimestamps"),
                  onSave: () => {
                    void save(
                      transcriptText(paragraphs, { timestamps: true }),
                      t("result.fileName", { title }),
                      "text",
                    );
                  },
                },
                {
                  id: "plain",
                  label: t("result.saveWithoutTimestamps"),
                  onSave: () => {
                    void save(
                      transcriptText(paragraphs, { timestamps: false }),
                      t("result.fileName", { title }),
                      "text",
                    );
                  },
                },
              ]}
            />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3.5 px-7 pt-5 pb-6">
              {paragraphs.map((paragraph) => (
                <div className="flex gap-4" key={paragraph.startMs}>
                  <span className="text-muted-foreground w-12 shrink-0 pt-px text-xs tabular-nums">
                    {formatTimestamp(paragraph.startMs)}
                  </span>
                  <p className="max-w-xl text-sm leading-relaxed text-pretty">
                    {paragraph.text}
                  </p>
                </div>
              ))}
              {!running && !hasText ? (
                <p className="text-muted-foreground text-sm">
                  {t("result.noSpeech")}
                </p>
              ) : null}
            </div>
          </ScrollArea>
        </section>
        <section
          aria-labelledby="transcribe-cleaned-title"
          className="flex min-h-0 flex-col"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b ps-7 pe-4">
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <h2
                className="text-sm font-semibold"
                id="transcribe-cleaned-title"
              >
                {t("cleaned.title")}
              </h2>
              <TruncatedText
                aria-live="polite"
                className="text-muted-foreground text-xs"
                render={<span />}
              >
                {cleanedStatus}
              </TruncatedText>
            </div>
            <PaneActions
              copyFormat={copyFormat}
              disabled={!cleanedReady}
              onCopy={async (format) =>
                await copy(
                  cleanedPlain,
                  format === "formatted" ? cleanedHtml : null,
                )
              }
              onCopyFormatChange={setCopyFormat}
              saveOptions={[
                {
                  id: "markdown",
                  label: t("cleaned.saveMarkdown"),
                  onSave: () => {
                    void save(
                      cleanedMarkdown(
                        cleanup.instructions,
                        cleanup.markdown,
                        instructionsLabel,
                      ),
                      t("cleaned.fileNameMarkdown", { title }),
                      "markdown",
                    );
                  },
                },
                {
                  id: "text",
                  label: t("cleaned.saveText"),
                  onSave: () => {
                    void save(
                      cleanedPlain,
                      t("cleaned.fileNameText", { title }),
                      "text",
                    );
                  },
                },
              ]}
            />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-7 pt-5 pb-6">
              {hasText && cleanup.started ? (
                <CleanedText cleanup={cleanup} transcribing={running} />
              ) : null}
              {hasText && !cleanup.started ? (
                <CleanupOffer onStart={cleanup.start} />
              ) : null}
            </div>
          </ScrollArea>
        </section>
      </div>
      <StatusRow
        actionFailed={actionFailed}
        doneMs={doneMs}
        job={session.job}
        matterName={session.matter?.name ?? null}
        onAnother={onAnother}
        outcome={outcome}
        saving={saving}
        totalMs={session.file.durationMs}
      />
    </Shell>
  );
};

/** The row under the text: progress and Stop while it runs, then how it
 *  ended and what was saved. */
const StatusRow = ({
  job,
  outcome,
  doneMs,
  totalMs,
  saving,
  matterName,
  actionFailed,
  onAnother,
}: {
  job: number;
  outcome: Finished | null;
  doneMs: number;
  totalMs: number | null;
  saving: Saving;
  matterName: string | null;
  actionFailed: boolean;
  onAnother: () => void;
}) => {
  const t = useTranslations("transcribe");
  const [stopping, setStopping] = useState(false);
  if (outcome === null) {
    const share = progressShare(doneMs, totalMs);
    return (
      <div
        className="text-muted-foreground flex shrink-0 items-center gap-3 border-t px-7 py-3 text-xs"
        role="status"
      >
        <span className="text-foreground-strong-muted whitespace-nowrap tabular-nums">
          {totalMs === null
            ? t("progress.runningUnknown", { done: wholeMinutes(doneMs) })
            : t("progress.running", {
                done: Math.min(wholeMinutes(doneMs), wholeMinutes(totalMs)),
                total: wholeMinutes(totalMs),
              })}
        </span>
        <div
          aria-hidden="true"
          className="bg-muted h-1 flex-1 overflow-hidden rounded-full"
        >
          <div
            className="bg-foreground h-full origin-left rounded-full transition-transform duration-200 rtl:origin-right"
            style={{ transform: `scaleX(${share ?? 0})` }}
          />
        </div>
        <Button
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            void invoke("transcribe_stop", { job }).catch(() => {
              setStopping(false);
            });
          }}
          size="xs"
          variant="ghost"
        >
          {t("progress.stop")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-3 border-t px-7 py-3 text-xs">
      <div className="min-w-0 flex-1" role="status">
        <OutcomeLine
          actionFailed={actionFailed}
          doneMs={doneMs}
          matterName={matterName}
          outcome={outcome}
          saving={saving}
        />
      </div>
      <Button onClick={onAnother} size="xs" variant="ghost">
        {t("progress.another")}
      </Button>
    </div>
  );
};

const OutcomeLine = ({
  outcome,
  doneMs,
  saving,
  matterName,
  actionFailed,
}: {
  outcome: Finished;
  doneMs: number;
  saving: Saving;
  matterName: string | null;
  actionFailed: boolean;
}) => {
  const t = useTranslations("transcribe");
  if (saving.status === "saved" && matterName !== null) {
    return (
      <p className="text-foreground-strong-muted text-pretty">
        {t("result.savedToMatter", {
          matter: matterName,
          fileName: saving.fileName,
        })}
      </p>
    );
  }
  if (saving.status === "failed" || actionFailed) {
    return (
      <p className="text-destructive flex gap-1.5 text-pretty" role="alert">
        <TriangleAlertIcon
          aria-hidden="true"
          className="mt-px size-3.5 shrink-0"
        />
        {saving.status === "failed"
          ? t("result.saveToMatterFailed")
          : t("result.saveFailed")}
      </p>
    );
  }
  if (outcome.outcome === "failed") {
    return (
      <p className="text-destructive flex gap-1.5 text-pretty" role="alert">
        <TriangleAlertIcon
          aria-hidden="true"
          className="mt-px size-3.5 shrink-0"
        />
        {t(FAILURE_MESSAGES[outcome.failure])}
      </p>
    );
  }
  if (outcome.outcome === "stopped") {
    return (
      <p className="text-muted-foreground">
        {t("progress.stopped", { done: wholeMinutes(doneMs) })}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground">
      {t("progress.done", { total: wholeMinutes(outcome.durationMs) })}
    </p>
  );
};
