/**
 * The microphone dictation records from, and its test: the shapes the native
 * side sends (`dictation_microphone.rs`) and what Settings makes of them.
 * The test reports levels only; no audio reaches this window.
 */

import { panic } from "better-result";

type InputDevice = { bluetooth: boolean; id: string; name: string };

export type MicrophonesSnapshot = {
  /** The chosen device's id; null for the system default. */
  chosen: string | null;
  /** The chosen device's name while it is not connected. */
  chosenMissing: string | null;
  defaultName: string | null;
  devices: InputDevice[];
};

type MicrophoneTestStatus = "hearing" | "listening" | "silent" | "zeros";

export type MicrophoneLevel = {
  device: string | null;
  finished: boolean;
  levelDb: number;
  peakDb: number;
  status: MicrophoneTestStatus;
};

/** The select's value for the system default; device ids never match it. */
export const SYSTEM_DEFAULT = "system-default";

/** Mirrors `LEVEL_EVENT` and `ENDED_EVENT`. */
export const MICROPHONE_LEVEL_EVENT = "dictation-microphone-level";
export const MICROPHONE_TEST_ENDED_EVENT = "dictation-microphone-test-ended";

/** The quietest level the meter shows; `FLOOR_DB` sits below it. */
const METER_FLOOR_DB = -60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isDevice = (value: unknown): value is InputDevice =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["name"] === "string" &&
  typeof value["bluetooth"] === "boolean";

const isNameOrNull = (value: unknown) =>
  value === null || typeof value === "string";

export const isMicrophonesSnapshot = (
  value: unknown,
): value is MicrophonesSnapshot =>
  isRecord(value) &&
  isNameOrNull(value["chosen"]) &&
  isNameOrNull(value["chosenMissing"]) &&
  isNameOrNull(value["defaultName"]) &&
  Array.isArray(value["devices"]) &&
  value["devices"].every(isDevice);

const STATUSES: readonly unknown[] = [
  "hearing",
  "listening",
  "silent",
  "zeros",
];

export const isMicrophoneLevel = (value: unknown): value is MicrophoneLevel =>
  isRecord(value) &&
  isNameOrNull(value["device"]) &&
  typeof value["finished"] === "boolean" &&
  typeof value["levelDb"] === "number" &&
  typeof value["peakDb"] === "number" &&
  STATUSES.includes(value["status"]);

/** The select's value: the chosen device, or the system default. */
export const selectedMicrophone = (snapshot: MicrophonesSnapshot) =>
  snapshot.chosen ?? SYSTEM_DEFAULT;

/** The device id a change to `value` stores; null for the system default. */
export const microphoneChoice = (value: string) =>
  value === SYSTEM_DEFAULT ? null : value;

/** How full the meter is for `db`, from 0 to 1. */
export const meterFraction = (db: number) =>
  Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));

/** The status line's message key under `dictation.microphone`, if any. */
export const testMessage = (level: MicrophoneLevel | null) => {
  if (level === null) {
    return null;
  }
  switch (level.status) {
    case "hearing":
      return "hearing";
    case "silent":
    case "zeros":
      return "noSound";
    case "listening":
      return null;
    default:
      level.status satisfies never;
      return panic("Unknown microphone test status.");
  }
};
