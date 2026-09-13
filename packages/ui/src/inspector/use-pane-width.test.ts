import { describe, expect, test } from "bun:test";

import {
  INSPECTOR_PANE_DEFAULT_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
} from "./pane-width";
import {
  parsePersistedPaneWidth,
  readStoredWidth,
  resolveDragWidth,
  writeStoredWidth,
} from "./use-pane-width";

describe("parsePersistedPaneWidth", () => {
  test("returns the default when nothing was persisted", () => {
    expect(parsePersistedPaneWidth(null)).toBe(INSPECTOR_PANE_DEFAULT_WIDTH);
  });

  test("restores a width inside the pane's own bounds", () => {
    expect(parsePersistedPaneWidth("640")).toBe(640);
    expect(parsePersistedPaneWidth(String(INSPECTOR_PANE_MIN_WIDTH))).toBe(
      INSPECTOR_PANE_MIN_WIDTH,
    );
    expect(parsePersistedPaneWidth(String(INSPECTOR_PANE_MAX_WIDTH))).toBe(
      INSPECTOR_PANE_MAX_WIDTH,
    );
  });

  // A corrupt entry must not strand the pane at a width the handle cannot
  // recover from, so it falls back rather than being clamped.
  test("rejects junk and out-of-range widths", () => {
    for (const raw of ["", "abc", "NaN", "-1", "0", "10", "5000", "1e9"]) {
      expect(parsePersistedPaneWidth(raw)).toBe(INSPECTOR_PANE_DEFAULT_WIDTH);
    }
  });
});

describe("resolveDragWidth", () => {
  test("measures from the inline-end edge in LTR", () => {
    expect(
      resolveDragWidth({ clientX: 1400, isRtl: false, viewportWidth: 1920 }),
    ).toBe(520);
  });

  test("measures from the inline-start edge in RTL", () => {
    expect(
      resolveDragWidth({ clientX: 520, isRtl: true, viewportWidth: 1920 }),
    ).toBe(520);
  });

  // Without the RTL branch the delta inverts and the drag oscillates.
  test("both directions agree for a mirrored pointer position", () => {
    const viewportWidth = 1440;
    const ltr = resolveDragWidth({
      clientX: viewportWidth - 400,
      isRtl: false,
      viewportWidth,
    });
    const rtl = resolveDragWidth({ clientX: 400, isRtl: true, viewportWidth });
    expect(ltr).toBe(rtl);
  });
});

describe("stored width", () => {
  // `window.localStorage` is a getter that throws where storage is blocked, so
  // a pane that persists its width must not take the surrounding UI down with
  // it. The fake below throws from the property itself, the way a sandboxed
  // iframe does.
  const withWindow = (localStorage: unknown, run: () => void) => {
    const globals: { window?: unknown } = globalThis;
    const had = "window" in globals;
    const previous = globals.window;
    globals.window = Object.defineProperty({}, "localStorage", {
      get: () => localStorage,
    });
    try {
      run();
    } finally {
      if (had) {
        globals.window = previous;
      } else {
        delete globals.window;
      }
    }
  };

  const blockedStorage = () => {
    throw new Error("storage is disabled");
  };

  test("falls back to the default when storage throws", () => {
    withWindow(undefined, () => {
      expect(readStoredWidth("inspector-pane-width")).toBe(
        INSPECTOR_PANE_DEFAULT_WIDTH,
      );
    });
  });

  test("reads a persisted width when storage works", () => {
    withWindow({ getItem: () => "640", setItem: () => undefined }, () => {
      expect(readStoredWidth("inspector-pane-width")).toBe(640);
    });
  });

  // The pane renders whatever it read back, so a width that does not survive
  // the round trip snaps the pane somewhere the reader never dragged it.
  test("every width the pane can take survives write then read", () => {
    const entries = new Map<string, string>();
    withWindow(
      {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
          entries.set(key, value);
        },
      },
      () => {
        for (const width of [
          INSPECTOR_PANE_MIN_WIDTH,
          INSPECTOR_PANE_MIN_WIDTH + 1,
          INSPECTOR_PANE_DEFAULT_WIDTH,
          777,
          INSPECTOR_PANE_MAX_WIDTH - 1,
          INSPECTOR_PANE_MAX_WIDTH,
        ]) {
          writeStoredWidth("inspector-pane-width", width);
          expect(readStoredWidth("inspector-pane-width")).toBe(width);
        }
      },
    );
  });

  // Two docked panes must not read each other's width back.
  test("keeps each key's width to itself", () => {
    const entries = new Map<string, string>();
    withWindow(
      {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
          entries.set(key, value);
        },
      },
      () => {
        writeStoredWidth("matter", 640);
        writeStoredWidth("public-law", 420 + INSPECTOR_PANE_MIN_WIDTH);
        expect(readStoredWidth("matter")).toBe(640);
        expect(readStoredWidth("public-law")).toBe(
          420 + INSPECTOR_PANE_MIN_WIDTH,
        );
      },
    );
  });

  test("writing to blocked storage is not an error", () => {
    withWindow(
      {
        getItem: blockedStorage,
        setItem: blockedStorage,
      },
      () => {
        expect(readStoredWidth("inspector-pane-width")).toBe(
          INSPECTOR_PANE_DEFAULT_WIDTH,
        );
        expect(() => {
          writeStoredWidth("inspector-pane-width", 640);
        }).not.toThrow();
      },
    );
  });
});
