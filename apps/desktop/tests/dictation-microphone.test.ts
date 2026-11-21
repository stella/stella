import { describe, expect, test } from "bun:test";

import {
  isMicrophoneLevel,
  isMicrophonesSnapshot,
  meterFraction,
  microphoneChoice,
  selectedMicrophone,
  SYSTEM_DEFAULT,
  testMessage,
} from "../src/mainview/dictation-microphone";

const LISTED = {
  chosen: null,
  chosenMissing: null,
  defaultName: "AirPods Pro 3",
  devices: [{ bluetooth: true, id: "coreaudio:A", name: "AirPods Pro 3" }],
};

const level = (status: string) => ({
  device: "AirPods Pro 3",
  finished: false,
  levelDb: -30,
  peakDb: -24,
  status,
});

describe("dictation microphone", () => {
  test("no choice selects the system default, which stores no id", () => {
    expect(selectedMicrophone(LISTED)).toBe(SYSTEM_DEFAULT);
    expect(microphoneChoice(SYSTEM_DEFAULT)).toBeNull();
    expect(selectedMicrophone({ ...LISTED, chosen: "coreaudio:A" })).toBe(
      "coreaudio:A",
    );
    expect(microphoneChoice("coreaudio:A")).toBe("coreaudio:A");
  });

  test("the meter spans -60 to 0 dBFS", () => {
    expect(meterFraction(-90)).toBe(0);
    expect(meterFraction(-60)).toBe(0);
    expect(meterFraction(-30)).toBe(0.5);
    expect(meterFraction(0)).toBe(1);
    expect(meterFraction(6)).toBe(1);
    expect(meterFraction(-Infinity)).toBe(0);
  });

  test("the status line says hearing or no sound, nothing while listening", () => {
    expect(testMessage(null)).toBeNull();
    expect(
      testMessage({ ...level("listening"), status: "listening" }),
    ).toBeNull();
    expect(testMessage({ ...level("hearing"), status: "hearing" })).toBe(
      "hearing",
    );
    expect(testMessage({ ...level("silent"), status: "silent" })).toBe(
      "noSound",
    );
    expect(testMessage({ ...level("zeros"), status: "zeros" })).toBe("noSound");
  });

  test("only the native side's shapes are accepted", () => {
    expect(isMicrophonesSnapshot(LISTED)).toBe(true);
    expect(isMicrophonesSnapshot({ ...LISTED, devices: [{ id: 1 }] })).toBe(
      false,
    );
    expect(isMicrophonesSnapshot({ ...LISTED, chosen: 3 })).toBe(false);
    expect(isMicrophoneLevel(level("hearing"))).toBe(true);
    expect(isMicrophoneLevel(level("loud"))).toBe(false);
    expect(isMicrophoneLevel({ ...level("hearing"), levelDb: "-3" })).toBe(
      false,
    );
  });
});
