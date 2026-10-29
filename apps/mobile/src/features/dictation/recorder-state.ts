import type { NativeDraft } from "@/native/dictation-recorder";

const RECORDER_ACTIONS = [
  "record",
  "pause",
  "resume",
  "finish",
  "marker",
  "delete",
] as const;

type RecorderAction = (typeof RECORDER_ACTIONS)[number];
type RecorderStatus = "idle" | NativeDraft["status"];

const ALLOWED_ACTIONS = {
  idle: {
    record: true,
    pause: false,
    resume: false,
    finish: false,
    marker: false,
    delete: false,
  },
  recording: {
    record: false,
    pause: true,
    resume: false,
    finish: true,
    marker: true,
    delete: false,
  },
  paused: {
    record: false,
    pause: false,
    resume: true,
    finish: true,
    marker: false,
    delete: true,
  },
  finished: {
    record: false,
    pause: false,
    resume: false,
    finish: false,
    marker: false,
    delete: true,
  },
} as const satisfies Record<RecorderStatus, Record<RecorderAction, boolean>>;

export const canApplyRecorderAction = (
  status: RecorderStatus,
  action: RecorderAction,
): boolean => ALLOWED_ACTIONS[status][action];
