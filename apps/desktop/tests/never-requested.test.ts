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

const nativeFiles = filesUnder(NATIVE_ROOT, (file) => file.endsWith(".rs"));

const nativeSources = nativeFiles
  .map((file) => readFileSync(file, "utf-8"))
  .join("\n");

const readNative = (file: string) =>
  readFileSync(path.join(NATIVE_ROOT, file), "utf-8");

/** The body of the function whose signature starts with `signature`, up to
 *  the closing brace at the start of a line. */
const functionBody = (source: string, signature: string) => {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end);
};

/** Key presses and releases in an event mask: what a tap that sees typing
 *  subscribes to. */
const KEYBOARD_EVENTS = /\bKeyDown\b|\bKeyUp\b|kCGEventMaskForAllEvents/u;

/** Creating a macOS event tap, by its C name or its Rust binding. */
const TAP_CREATION =
  /\bCGEventTapCreate|\btap_create(?:_for_pid|_for_psn)?\s*\(/u;

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
  // The one macOS event tap sees modifier changes only, which needs no
  // Input Monitoring; a test below checks its event mask.
  keystrokes: {
    declarations: ["NSInputMonitoringUsageDescription"],
    nativeCalls:
      /\bCGEventTapCreate\b|addGlobalMonitorForEventsMatchingMask|\bIOHIDRequestAccess\b|\bCGRequestListenEventAccess\b/u,
  },
  // Windows asks nobody before an app hooks the keyboard. The only hook is
  // the one a hold key the speaker chooses needs; tests below keep the
  // Windows default on a shortcut that needs none.
  keystrokesWithoutHoldKey: {
    declarations: [],
    nativeCalls: null,
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

  test("Windows hooks the keyboard only for a chosen hold key", () => {
    const hooks = filesUnder(
      NATIVE_ROOT,
      (file) =>
        file.endsWith(".rs") &&
        /\bSetWindowsHookEx/u.test(readFileSync(file, "utf-8")),
    );
    expect(hooks.map((file) => path.basename(file))).toEqual([
      "windows_hold_key.rs",
    ]);
    const choices = readFileSync(
      path.join(NATIVE_ROOT, "src/dictation_hold_key.rs"),
      "utf-8",
    );
    expect(choices).toMatch(
      /cfg!\(target_os = "windows"\)\s*\{\s*&\[Self::Combination,/u,
    );
  });

  test("the only macOS event tap listens to modifier changes, never to typing", () => {
    const taps = nativeFiles.filter((file) =>
      TAP_CREATION.test(readFileSync(file, "utf-8")),
    );
    expect(taps.map((file) => path.basename(file))).toEqual(["hold_key.rs"]);
    const source = readNative("crates/macos-park/src/hold_key.rs");
    expect(source.match(/\btap_create\s*\(/gu)).toHaveLength(1);
    const createTap = functionBody(source, "fn create_tap(");
    expect(createTap).toMatch(
      /let mask: CGEventMask = 1 << CGEventType::FlagsChanged\.0;/u,
    );
    expect(createTap.match(/<</gu)).toHaveLength(1);
    expect(createTap).not.toMatch(KEYBOARD_EVENTS);
    expect(createTap).toMatch(/CGEventTapOptions::ListenOnly,\s*mask,/u);
    // Created only with Accessibility access, so macOS never asks for
    // Input Monitoring.
    expect(createTap).toMatch(
      /if !crate::accessibility_trusted\(\) \{\s*return None;\s*\}[\s\S]*tap_create/u,
    );
  });

  test("the combination listens through the registered shortcut; only a chosen hold key starts a listener", () => {
    const dictation = readNative("src/dictation.rs");
    const listen = functionBody(dictation, "fn listen(app: &AppHandle) {");
    expect(listen).toMatch(
      /HoldChoice::Combination => \{\s*match app\.global_shortcut\(\)\.on_shortcut\(shortcut\(\), on_shortcut\)/u,
    );
    expect(listen.match(/\blisten_for_hold_key\(/gu)).toHaveLength(1);
    expect(listen).toMatch(
      /_ => listen_for_hold_key\(app, choice, generation\),/u,
    );
    // Besides that dispatch, the listener is started only by the function
    // it dispatches to, and only from dictation.
    expect(dictation.match(/(?<!fn )\blisten_for_hold_key\(/gu)).toEqual([
      "listen_for_hold_key(",
      "listen_for_hold_key(",
    ]);
    expect(dictation).toMatch(
      /fn listen_for_hold_key\([\s\S]*stella_desktop_macos::listen_for_hold_key\(key, on_edge, on_listening\)/u,
    );
    const callers = nativeFiles.filter(
      (file) =>
        !file.includes(`${path.sep}crates${path.sep}`) &&
        /\blisten_for_hold_key\b/u.test(readFileSync(file, "utf-8")),
    );
    expect(callers.map((file) => path.basename(file))).toEqual([
      "dictation.rs",
    ]);
  });

  test("the Windows installer stays per-user", () => {
    const config: unknown = JSON.parse(
      readFileSync(path.join(NATIVE_ROOT, "tauri.conf.json"), "utf-8"),
    );
    expect(config).toMatchObject({
      bundle: { windows: { nsis: { installMode: "currentUser" } } },
    });
  });

  test("the evidence check catches a declaration it is meant to catch", () => {
    expect(`${declarations}\nNSCameraUsageDescription`).toContain(
      EVIDENCE.camera.declarations[0],
    );
    expect("CGRequestScreenCaptureAccess();").toMatch(
      EVIDENCE.screenRecording.nativeCalls,
    );
    expect("CGEvent::tap_create(").toMatch(TAP_CREATION);
    expect("let mask = 1 << CGEventType::KeyDown.0;").toMatch(KEYBOARD_EVENTS);
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
