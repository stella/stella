import { createContext, use, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";

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

const DesktopAppearanceContext = createContext<DesktopAppearance | null>(null);

export const DesktopAppearanceProvider = ({
  appearance,
  children,
}: React.PropsWithChildren<{ appearance: DesktopAppearance }>) => (
  <DesktopAppearanceContext value={appearance}>
    {children}
  </DesktopAppearanceContext>
);

/** The appearance the window draws in, as chosen. */
export const useDesktopAppearance = (): DesktopAppearance =>
  use(DesktopAppearanceContext) ??
  panic("useDesktopAppearance needs a DesktopAppearanceProvider");

/**
 * Keeps the window in the native appearance: the cached copy first, the
 * native answer once it arrives, and every change another window makes.
 * Returns the appearance for `DesktopAppearanceProvider`.
 */
export const useAppliedDesktopAppearance = (
  telemetryWindow: DesktopTelemetryWindow,
): DesktopAppearance => {
  const [appearance, setAppearance] = useState(readCachedAppearance);

  // A change that lands while the start-up read is still awaiting the native
  // side is newer; the read must not roll it back.
  const changes = useRef(0);

  useEffect(() => {
    const changesAtStart = changes.current;
    const read = async () => {
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
      if (changes.current === changesAtStart) {
        cacheAppearance(result.value);
        setAppearance(result.value);
      }
    };
    void read();
  }, [telemetryWindow]);

  useEffect(
    () =>
      subscribeDesktopEvent<{ appearance: unknown }>({
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
          changes.current += 1;
          cacheAppearance(payload.appearance);
          setAppearance(payload.appearance);
        },
        onError: () => {
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
            operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
            window: telemetryWindow,
          });
        },
      }),
    [telemetryWindow],
  );

  useEffect(() => {
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

  return appearance;
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
