import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root as ReactRoot } from "react-dom/client";

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
import { subscribeDesktopEvent } from "../shared/desktop-events";
import { useSystemTheme } from "../shared/use-system-theme";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  describeError,
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

  useEffect(
    () =>
      subscribeDesktopEvent<{ language: string }>({
        event: DESKTOP_LANGUAGE_CHANGED_EVENT,
        handler: ({ payload }) => {
          if (isSupportedLanguage(payload.language)) {
            setLanguage(payload.language);
          }
        },
        onError: () => {
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
            operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
            window: telemetryWindow,
          });
        },
      }),
    [],
  );

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
      onCaughtError: (error) => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.reactCaught,
          detail: describeError(error),
          operation: DESKTOP_TELEMETRY_OPERATIONS.render,
          window: telemetryWindow,
        });
      },
      onRecoverableError: (error) => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.reactRecoverable,
          detail: describeError(error),
          operation: DESKTOP_TELEMETRY_OPERATIONS.render,
          window: telemetryWindow,
        });
      },
      onUncaughtError: (error) => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.reactUncaught,
          detail: describeError(error),
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
