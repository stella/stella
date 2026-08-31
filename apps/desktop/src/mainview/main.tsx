import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root as ReactRoot } from "react-dom/client";

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { panic } from "better-result";

import ClipboardApp from "../clipboard/ClipboardApp";
import {
  defaultMessages,
  DESKTOP_LANGUAGE_CHANGED_EVENT,
  DesktopIntlProvider,
  getPreferredLanguage,
  isSupportedLanguage,
  loadMessages,
} from "../i18n";
import type { DesktopMessages } from "../i18n";
import { useSystemTheme } from "../shared/use-system-theme";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  desktopTelemetryWindowFromLabel,
  installDesktopErrorTelemetry,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import App from "./App";
import "./index.css";

const REACT_ROOT_KEY = Symbol.for("legal.stella.desktop.react-root");
const ClipboardEditor = lazy(
  async () => import("../clipboard/ClipboardEditor"),
);

const isReactRoot = (value: unknown): value is ReactRoot =>
  typeof value === "object" &&
  value !== null &&
  "render" in value &&
  typeof value.render === "function";

const Root = () => {
  useSystemTheme();

  const [language, setLanguage] = useState(getPreferredLanguage);
  const [messages, setMessages] = useState<DesktopMessages>(defaultMessages);

  useEffect(() => {
    let disposed = false;
    void loadMessages(language).then((nextMessages) => {
      if (!disposed) {
        setMessages(nextMessages);
      }
      return;
    });

    return () => {
      disposed = true;
    };
  }, [language]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void listen<{ language: string }>(
      DESKTOP_LANGUAGE_CHANGED_EVENT,
      ({ payload }) => {
        if (isSupportedLanguage(payload.language)) {
          setLanguage(payload.language);
        }
      },
    ).then((unlisten) => {
      cleanup = unlisten;
      return;
    });

    return () => {
      cleanup?.();
    };
  }, []);

  const windowLabel = getCurrentWindow().label;
  let content = <App />;
  if (windowLabel === "clipboard") {
    content = <ClipboardApp />;
  } else if (windowLabel === "clipboard-editor") {
    content = (
      <Suspense
        fallback={
          <main className="clipboard-editor-window bg-background min-h-dvh" />
        }
      >
        <ClipboardEditor />
      </Suspense>
    );
  }

  return (
    <StrictMode>
      <DesktopIntlProvider language={language} messages={messages}>
        {content}
      </DesktopIntlProvider>
    </StrictMode>
  );
};

const rootElement = document.querySelector("#root");

if (!(rootElement instanceof HTMLDivElement)) {
  panic("Missing root element for stella desktop.");
}

const telemetryWindow = desktopTelemetryWindowFromLabel(
  getCurrentWindow().label,
);
const removeDesktopErrorTelemetry =
  installDesktopErrorTelemetry(telemetryWindow);

const existingRoot: unknown = Reflect.get(rootElement, REACT_ROOT_KEY);
const reactRoot = isReactRoot(existingRoot)
  ? existingRoot
  : createRoot(rootElement, {
      onCaughtError: () => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.reactCaught,
          operation: DESKTOP_TELEMETRY_OPERATIONS.render,
          window: telemetryWindow,
        });
      },
      onRecoverableError: () => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.reactRecoverable,
          operation: DESKTOP_TELEMETRY_OPERATIONS.render,
          window: telemetryWindow,
        });
      },
      onUncaughtError: () => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.reactUncaught,
          operation: DESKTOP_TELEMETRY_OPERATIONS.render,
          window: telemetryWindow,
        });
      },
    });
Reflect.set(rootElement, REACT_ROOT_KEY, reactRoot);
reactRoot.render(<Root />);

if (import.meta.hot) {
  import.meta.hot.dispose(removeDesktopErrorTelemetry);
}
