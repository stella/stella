import { Result } from "better-result";
import * as v from "valibot";

import { joinChunks } from "@/state/dictation-chunks";

/**
 * The stella keyboard's side of the app, without the device: what the
 * keyboard's link and the native session (`modules/keyboard-dictation`)
 * hand over, and how a keyboard dictation's pieces become its text.
 */

/**
 * The languages the keyboard's language key offers, `auto` first: the
 * transcription then hears which one is spoken. The keyboard's own list
 * (`KeyboardDictationBridge.swift`) is pinned to this one by its test.
 */
export const KEYBOARD_LANGUAGES = [
  "auto",
  "cs",
  "sk",
  "en",
  "de",
  "pl",
] as const;

export type KeyboardLanguage = (typeof KEYBOARD_LANGUAGES)[number];

/**
 * The keyboard's letter layouts, as Settings offers them. The keyboard's own
 * list (`KeyboardLayoutChoice` in the bridge) is pinned to this one.
 */
export const KEYBOARD_LAYOUTS = ["qwertz", "qwerty"] as const;

export type KeyboardLayout = (typeof KEYBOARD_LAYOUTS)[number];

/**
 * The layout the keyboard uses before one is picked: Czech QWERTZ for a
 * Czech or Slovak speaker, QWERTY otherwise. The keyboard decides the same
 * by the phone's first language (`KeyboardLayoutChoice.fallback`).
 */
export const defaultKeyboardLayout = (locale: string): KeyboardLayout => {
  const language = locale.split("-")[0];
  return language === "cs" || language === "sk" ? "qwertz" : "qwerty";
};

/** The language the transcription is told: none for `auto`. */
export const transcriptionLanguage = (
  language: KeyboardLanguage,
): string | undefined => (language === "auto" ? undefined : language);

/**
 * How long the app keeps the microphone warm after a keyboard dictation, in
 * seconds. Off (0), the keyboard opens the app for every dictation.
 */
export const KEEP_WARM_CHOICES = [0, 300, 900, 3600] as const;

export type KeepWarm = (typeof KEEP_WARM_CHOICES)[number];

/** What the session keeps; anything else is a setting this build never wrote, so off. */
export const keepWarmOf = (seconds: number): KeepWarm =>
  KEEP_WARM_CHOICES.find((choice) => choice === seconds) ?? 0;

/**
 * A link from the keyboard older than this only warms the microphone: it
 * never starts a recording the person no longer expects
 * (`handoffWindowMs` in the bridge).
 */
export const KEYBOARD_HANDOFF_WINDOW_MS = 10_000;

/** What the keyboard's link asks the app to do as it opens. */
export type KeyboardHandoff =
  | {
      readonly type: "record";
      readonly jobId: string;
      readonly language: KeyboardLanguage;
    }
  | { readonly type: "warm" };

const handoffSchema = v.object({
  job: v.pipe(v.string(), v.uuid()),
  language: v.picklist(KEYBOARD_LANGUAGES),
  at: v.pipe(v.string(), v.digits(), v.transform(Number)),
});

/**
 * The keyboard's link, read from the route's parameters: a fresh one starts
 * the dictation it names; a stale, partial or foreign one only opens the
 * app with the microphone warm.
 */
export const readKeyboardHandoff = (
  params: Readonly<Record<string, string | string[] | undefined>>,
  now: number,
): KeyboardHandoff => {
  const parsed = v.safeParse(handoffSchema, params);
  if (!parsed.success) {
    return { type: "warm" };
  }
  const { at, job, language } = parsed.output;
  const age = now - at;
  return age >= 0 && age <= KEYBOARD_HANDOFF_WINDOW_MS
    ? { type: "record", jobId: job, language }
    : { type: "warm" };
};

const pieceSchema = v.object({
  jobId: v.pipe(v.string(), v.uuid()),
  index: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Absent when the piece held no audio: a stop right after a cut. */
  uri: v.optional(v.string()),
  language: v.picklist(KEYBOARD_LANGUAGES),
  durationMs: v.number(),
  last: v.boolean(),
});

/** One recorded piece of a keyboard dictation, as the session hands it over. */
export type KeyboardPiece = v.InferOutput<typeof pieceSchema>;

/**
 * The session's pieces. The native module and this bundle ship together
 * (an update reaches only builds of the same native fingerprint), so any
 * other shape is a bug, and fails loudly.
 */
export const parseKeyboardPieces = (raw: unknown): KeyboardPiece[] =>
  v.parse(v.array(pieceSchema), raw);

const statusSchema = v.object({
  active: v.boolean(),
  phase: v.picklist(["ready", "recording", "transcribing"]),
  keepWarmSeconds: v.number(),
  warmUntil: v.optional(v.number()),
  jobId: v.optional(v.string()),
  keyboardSeenAt: v.optional(v.number()),
  layout: v.optional(v.picklist(KEYBOARD_LAYOUTS)),
});

/** The session as the app shows it. */
type KeyboardSession =
  | { readonly type: "off" }
  | {
      readonly type: "warm";
      readonly phase: "ready" | "recording" | "transcribing";
      /** When a session with nothing under way closes. */
      readonly warmUntil: number;
      readonly jobId: string | undefined;
    };

export type KeyboardStatus = {
  readonly session: KeyboardSession;
  readonly keepWarm: KeepWarm;
  /** When the keyboard last ran with Full Access; null before it has. */
  readonly keyboardSeenAt: number | null;
  /** The layout picked in Settings; null before one is. */
  readonly layout: KeyboardLayout | null;
};

/** The session's status, as `parseKeyboardPieces` reads its pieces. */
export const parseKeyboardStatus = (raw: unknown): KeyboardStatus => {
  const {
    active,
    jobId,
    keepWarmSeconds,
    keyboardSeenAt,
    layout,
    phase,
    warmUntil,
  } = v.parse(statusSchema, raw);
  return {
    session: active
      ? { type: "warm", phase, warmUntil: warmUntil ?? 0, jobId }
      : { type: "off" },
    keepWarm: keepWarmOf(keepWarmSeconds),
    keyboardSeenAt: keyboardSeenAt ?? null,
    layout: layout ?? null,
  };
};

/** What a keyboard dictation came to, for the keyboard to insert or say. */
export type KeyboardOutcome =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "silent" }
  | { readonly type: "failed" };

type KeyboardJobsOptions<Setup> = {
  /** What the dictation is transcribed with, read once per dictation. */
  readonly prepare: () => Promise<Setup>;
  /** One piece's text, null when it could not be transcribed. */
  readonly transcribe: (
    piece: { readonly uri: string; readonly language: KeyboardLanguage },
    setup: Setup,
  ) => Promise<string | null>;
  /** The joined text as the person gets it: cleaned up when they chose that. */
  readonly finish: (joined: string, setup: Setup) => Promise<string>;
  readonly deliver: (jobId: string, outcome: KeyboardOutcome) => void;
};

type Job<Setup> = {
  readonly setup: Promise<Setup>;
  /** Each piece's text by its index, transcribed as it arrives. */
  readonly pieces: Map<number, Promise<string | null>>;
  /** Every index taken, a last piece without audio included. */
  readonly seen: Set<number>;
  /** The last piece's index, once it came. */
  last: number | undefined;
};

/**
 * Keyboard dictations under way. Each piece is transcribed as it arrives,
 * while the next is recorded; the dictation ends once its last piece and
 * every one before it have come, in whatever order, and its pieces' texts
 * are joined in spoken order and delivered. A piece that failed
 * leaves a gap, and the rest is still delivered; with nothing heard, the
 * outcome says whether nothing was said or nothing could be transcribed.
 */
export const keyboardJobs = <Setup>(options: KeyboardJobsOptions<Setup>) => {
  const jobs = new Map<string, Job<Setup>>();
  return {
    /** Takes pieces in; settles once every dictation they ended is delivered, and never rejects. */
    take: async (pieces: readonly KeyboardPiece[]): Promise<void> => {
      const ended: Promise<void>[] = [];
      for (const piece of pieces) {
        const job = jobs.get(piece.jobId) ?? {
          setup: options.prepare(),
          pieces: new Map(),
          seen: new Set(),
          last: undefined,
        };
        jobs.set(piece.jobId, job);
        const { uri } = piece;
        if (uri !== undefined) {
          job.pieces.set(piece.index, transcribed(options, job, uri, piece));
        }
        job.seen.add(piece.index);
        if (piece.last) {
          job.last = piece.index;
        }
        if (job.last !== undefined && job.seen.size > job.last) {
          jobs.delete(piece.jobId);
          ended.push(conclude(options, job, piece.jobId));
        }
      }
      await Promise.all(ended);
    },
  };
};

const transcribed = async <Setup>(
  options: KeyboardJobsOptions<Setup>,
  job: Job<Setup>,
  uri: string,
  { language }: KeyboardPiece,
): Promise<string | null> => {
  const text = await Result.tryPromise(
    async () => await options.transcribe({ uri, language }, await job.setup),
  );
  return text.isOk() ? text.value : null;
};

const conclude = async <Setup>(
  options: KeyboardJobsOptions<Setup>,
  job: Job<Setup>,
  jobId: string,
): Promise<void> => {
  const texts = await Promise.all(
    // A fresh array, sorted in place: Hermes has no `toSorted`.
    [...job.pieces.entries()]
      .sort(([first], [second]) => first - second)
      .map(async ([, text]) => await text),
  );
  const heard = texts.filter((text) => text !== null);
  const joined = joinChunks(heard);
  if (joined === "") {
    options.deliver(jobId, {
      type: heard.length < texts.length ? "failed" : "silent",
    });
    return;
  }
  const finished = await Result.tryPromise(
    async () => await options.finish(joined, await job.setup),
  );
  const text =
    finished.isOk() && finished.value !== "" ? finished.value : joined;
  options.deliver(jobId, { type: "text", text });
};
