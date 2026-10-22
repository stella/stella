import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import en from "../src/i18n/langs/en.json";
import hu from "../src/i18n/langs/hu.json";
import pl from "../src/i18n/langs/pl.json";
import { NEVER_REQUESTED } from "../src/onboarding/onboarding-types";
import type { NeverRequested } from "../src/onboarding/onboarding-types";

// Setup tells the user what the app never asks for. Each claim is checked
// against what would contradict it: a usage description or entitlement a
// bundle would declare, the native call that would trigger the OS prompt,
// or an installer that elevates. Adding one of those fails here until the
// claim is removed from the list.

const NATIVE_ROOT = path.join(import.meta.dir, "../src-tauri");

const filesUnder = (directory: string, keep: (file: string) => boolean) =>
  readdirSync(directory).flatMap((entry): string[] => {
    if (entry === "target" || entry === "gen" || entry === "node_modules") {
      return [];
    }
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      return filesUnder(full, keep);
    }
    return keep(full) ? [full] : [];
  });

const declarations = [
  readFileSync(path.join(NATIVE_ROOT, "tauri.conf.json"), "utf-8"),
  ...filesUnder(NATIVE_ROOT, (file) =>
    /\.(?:plist|entitlements)$/u.test(file),
  ).map((file) => readFileSync(file, "utf-8")),
].join("\n");

const nativeSources = filesUnder(NATIVE_ROOT, (file) => file.endsWith(".rs"))
  .map((file) => readFileSync(file, "utf-8"))
  .join("\n");

type Evidence = {
  /** Info.plist usage keys or entitlements that would declare the access. */
  declarations: readonly string[];
  /** Native calls that would ask for it. */
  nativeCalls: RegExp | null;
};

const EVIDENCE = {
  administrator: {
    declarations: ['"perMachine"', '"both"', "requireAdministrator"],
    nativeCalls: null,
  },
  camera: {
    declarations: [
      "NSCameraUsageDescription",
      "com.apple.security.device.camera",
    ],
    nativeCalls: /\bAVCaptureDevice\b|\bMediaCapture\b/u,
  },
  fullDiskAccess: {
    declarations: ["com.apple.security.files.all", "SystemPolicyAllFiles"],
    nativeCalls: null,
  },
  keystrokes: {
    declarations: ["NSInputMonitoringUsageDescription"],
    nativeCalls:
      /\bCGEventTapCreate\b|addGlobalMonitorForEventsMatchingMask|\bIOHIDRequestAccess\b|\bSetWindowsHookEx/u,
  },
  microphone: {
    declarations: [
      "NSMicrophoneUsageDescription",
      "com.apple.security.device.audio-input",
    ],
    nativeCalls: /\bAVAudioRecorder\b|\bAVAudioEngine\b|\bwaveInOpen\b/u,
  },
  screenRecording: {
    declarations: ["NSScreenCaptureUsageDescription"],
    nativeCalls:
      /\bCGRequestScreenCaptureAccess\b|\bSCShareableContent\b|\bCGWindowListCreateImage\b|\bSCStream\b|\bBitBlt\b/u,
  },
} as const satisfies Record<NeverRequested, Evidence>;

const claims = [...new Set(Object.values(NEVER_REQUESTED).flat())];

describe("never-requested claims", () => {
  test.each(claims)(
    "%s is neither declared nor asked for natively",
    (claim) => {
      const evidence: Evidence = EVIDENCE[claim];
      for (const declaration of evidence.declarations) {
        expect(declarations, `${claim}: ${declaration}`).not.toContain(
          declaration,
        );
      }
      if (evidence.nativeCalls) {
        expect(nativeSources, claim).not.toMatch(evidence.nativeCalls);
      }
    },
  );

  test("the Windows installer stays per-user", () => {
    const config: unknown = JSON.parse(
      readFileSync(path.join(NATIVE_ROOT, "tauri.conf.json"), "utf-8"),
    );
    expect(config).toMatchObject({
      bundle: { windows: { nsis: { installMode: "currentUser" } } },
    });
  });

  test("the evidence check catches a declaration it is meant to catch", () => {
    expect(`${declarations}\nNSMicrophoneUsageDescription`).toContain(
      EVIDENCE.microphone.declarations[0],
    );
    expect("CGRequestScreenCaptureAccess();").toMatch(
      EVIDENCE.screenRecording.nativeCalls,
    );
  });

  test("every claim has a name in the source catalogue", () => {
    expect(Object.keys(en.onboarding.never).toSorted()).toEqual(
      claims.toSorted(),
    );
  });
});

// The heading over the list must say the app never asks, in every locale that
// once phrased it as a request.
test("the never-requested label says the app never asks", () => {
  expect(hu.onboarding.neverRequested).toBe("Az alkalmazás soha nem kéri:");
  expect(pl.onboarding.neverRequested).toBe("Aplikacja nigdy nie prosi o:");
});
