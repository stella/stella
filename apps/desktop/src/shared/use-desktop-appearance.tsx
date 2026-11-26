import { createContext, use, useCallback, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";

import { useExternalSyncEffect } from "@stll/ui/effects";

import {
  describeError,
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import type { DesktopTelemetryWindow } from "../telemetry/desktop-telemetry";
import {
  cacheAppearance,
  DARK_SCHEME_QUERY,
  DESKTOP_APPEARANCE_CHANGED_EVENT,
  effectiveColorScheme,
  isDesktopAppearance,
  readCachedAppearance,
} from "./desktop-appearance";
import type {
  DesktopAppearance,
  DesktopColorScheme,
} from "./desktop-appearance";
import { subscribeDesktopEvent } from "./desktop-events";

export type DesktopAppearanceState = {
  appearance: DesktopAppearance;
  /** Takes a choice the native side confirmed saving, without waiting for
   *  its change event. */
  adopt: (appearance: DesktopAppearance) => void;
};

const DesktopAppearanceContext = createContext<DesktopAppearanceState | null>(
  null,
);

export const DesktopAppearanceProvider = ({
  value,
  children,
}: React.PropsWithChildren<{ value: DesktopAppearanceState }>) => (
  <DesktopAppearanceContext value={value}>{children}</DesktopAppearanceContext>
);

/** The appearance the window draws in, as chosen. */
export const useDesktopAppearance = (): DesktopAppearanceState =>
  use(DesktopAppearanceContext) ??
  panic("useDesktopAppearance needs a DesktopAppearanceProvider");

/**
 * Keeps the window in the native appearance: the cached copy first, the
 * native answer once it arrives, and every change another window makes.
 * Returns the state for `DesktopAppearanceProvider`.
 */
export const useAppliedDesktopAppearance = (
  telemetryWindow: DesktopTelemetryWindow,
): DesktopAppearanceState => {
  const [appearance, setAppearance] = useState(readCachedAppearance);

  // A change that lands while the start-up read is still awaiting the native
  // side is newer; the read must not roll it back.
  const changes = useRef(0);

  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- react/exhaustive-deps cannot see compiler memoization, and this value is an effect dependency
  const adopt = useCallback((next: DesktopAppearance) => {
    changes.current += 1;
    cacheAppearance(next);
    setAppearance(next);
  }, []);

  useExternalSyncEffect(() => {
    let disposed = false;
    let readStarted = false;
    // Runs once the listener is live: a change emitted before then would be
    // missed, and a read made before then could return the value it replaced.
    const read = async () => {
      if (readStarted) {
        return;
      }
      readStarted = true;
      const changesAtStart = changes.current;
      const result = await Result.tryPromise(async () =>
        invoke("get_desktop_appearance"),
      );
      if (Result.isError(result)) {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          detail: describeError(result.error),
          operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
          window: telemetryWindow,
        });
        return;
      }
      if (!isDesktopAppearance(result.value)) {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
          operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
          window: telemetryWindow,
        });
        return;
      }
      if (!disposed && changes.current === changesAtStart) {
        cacheAppearance(result.value);
        setAppearance(result.value);
      }
    };

    const unsubscribe = subscribeDesktopEvent<{ appearance: unknown }>({
      event: DESKTOP_APPEARANCE_CHANGED_EVENT,
      handler: ({ payload }) => {
        if (!isDesktopAppearance(payload.appearance)) {
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
            operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
            window: telemetryWindow,
          });
          return;
        }
        adopt(payload.appearance);
      },
      onSubscribed: () => {
        void read();
      },
      onError: () => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
          operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
          window: telemetryWindow,
        });
        // Without live changes the window still takes the saved choice once.
        void read();
      },
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [adopt, telemetryWindow]);

  useExternalSyncEffect(() => {
    const mediaQuery = window.matchMedia(DARK_SCHEME_QUERY);
    const update = () => {
      applyColorScheme(effectiveColorScheme(appearance, mediaQuery.matches));
    };

    update();
    mediaQuery.addEventListener("change", update);

    return () => {
      mediaQuery.removeEventListener("change", update);
    };
  }, [appearance]);

  return { adopt, appearance };
};

const applyColorScheme = (scheme: DesktopColorScheme) => {
  const root = document.documentElement;
  const restore = suppressTransitions();
  root.classList.toggle("dark", scheme === "dark");
  root.style.colorScheme = scheme;
  // The pre-paint background only covers the frames before the stylesheet.
  root.style.removeProperty("background-color");
  restore();
};

const suppressTransitions = () => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
  void getComputedStyle(document.documentElement).opacity;
  return () => {
    // Commit the themed values while transitions are still suppressed. A
    // requestAnimationFrame callback runs before paint, so removing the style
    // without this second flush can animate the theme change after all.
    void getComputedStyle(document.documentElement).opacity;
    requestAnimationFrame(() => style.remove());
  };
};
