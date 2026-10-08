import { panic } from "better-result";
import * as v from "valibot";

import {
  VISUAL_DATA_SCRIPT_ID,
  generatedVisualInputSchema,
} from "@stll/api-contract/generated-visual";
import {
  VISUAL_GUEST_MARKER_ATTRIBUTE,
  VISUAL_SANDBOX_LIMITS,
  visualLinkSchema,
} from "@stll/api-contract/visual-sandbox";
import {
  VISUAL_THEME_SCRIPT_ID,
  visualThemeSchema,
  type VisualTheme,
} from "@stll/api-contract/visual-theme";

import { createVisualMessageHandler } from "../bridge";
import { composeVisualDocument } from "../srcdoc";
import { parseVisualOuterConfig, whenVisualDocumentReady } from "./boot";
import { createVisualCharts } from "./charts";
import { createVisualGuestApi } from "./guest-api";
import { createVisualThemeHandler } from "./guest-theme";
import { isolateVisualGuest } from "./isolation";
import { applyVisualTheme, installVisualPresentation } from "./presentation";
import { visualShellReadyMessage } from "./shell-ready";

const bootGuest = (): void => {
  try {
    isolateVisualGuest();
    installVisualPresentation(document);
    const themeElement = document.querySelector(`#${VISUAL_THEME_SCRIPT_ID}`);
    if (themeElement) {
      applyVisualTheme(
        document,
        v.parse(visualThemeSchema, JSON.parse(themeElement.textContent)),
      );
    }
    window.addEventListener(
      "message",
      createVisualThemeHandler({
        parentWindow: window.parent,
        onTheme: (theme) => applyVisualTheme(document, theme),
      }),
    );
    const dataElement = document.querySelector(`#${VISUAL_DATA_SCRIPT_ID}`);
    if (!dataElement) {
      panic("The visual document has no data payload");
    }
    const data = v.parse(
      generatedVisualInputSchema.entries.data,
      JSON.parse(dataElement.textContent),
    );
    Object.defineProperty(window, "stella", {
      value: Object.freeze({
        ...createVisualGuestApi({
          data,
          postMessage: (message) => window.parent.postMessage(message, "*"),
          measureSize: () => ({
            width: Math.max(
              1,
              Math.min(10_000, Math.ceil(document.documentElement.scrollWidth)),
            ),
            height: Math.max(
              1,
              Math.min(
                VISUAL_SANDBOX_LIMITS.height,
                Math.ceil(document.documentElement.scrollHeight),
              ),
            ),
          }),
        }),
        charts: createVisualCharts(window),
      }),
      writable: false,
      configurable: false,
    });
  } catch (error) {
    window.stop();
    document.documentElement.replaceChildren();
    throw error;
  }
  const NativeElement = Element;
  const closest: unknown = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "closest",
  )?.value;
  const getAttribute: unknown = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getAttribute",
  )?.value;
  if (typeof closest !== "function" || typeof getAttribute !== "function") {
    panic("The visual link methods are unavailable");
  }
  const requestLink = (event: Event) => {
    if (!(event.target instanceof NativeElement)) {
      return;
    }
    const anchor: unknown = Reflect.apply(closest, event.target, [
      "a[data-stella-link]",
    ]);
    if (!(anchor instanceof NativeElement)) {
      return;
    }
    event.preventDefault();
    const parsed = v.safeParse(
      visualLinkSchema,
      Reflect.apply(getAttribute, anchor, ["data-stella-link"]),
    );
    if (parsed.success) {
      window.parent.postMessage({ kind: "open-link", url: parsed.output }, "*");
    }
  };
  document.addEventListener("click", requestLink);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      requestLink(event);
    }
  });
  const reportSize = () =>
    window.parent.postMessage(
      {
        kind: "resize",
        height: Math.max(
          1,
          Math.min(
            VISUAL_SANDBOX_LIMITS.height,
            Math.ceil(document.documentElement.scrollHeight),
          ),
        ),
      },
      "*",
    );
  whenVisualDocumentReady(document, () => {
    for (const anchor of document.querySelectorAll("a[data-stella-link]")) {
      anchor.setAttribute("role", "link");
      anchor.setAttribute("tabindex", "0");
    }
    new ResizeObserver(reportSize).observe(document.body);
    reportSize();
  });
};

const bootOuter = (runtime: string) => {
  const config = document.querySelector("#visual-config");
  if (!config || window.self === window.top) {
    return;
  }
  const boot: {
    current:
      | { type: "initializing" }
      | {
          type: "ready";
          receive: ReturnType<typeof createVisualMessageHandler>;
        };
  } = { current: { type: "initializing" } };
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (boot.current.type === "ready") {
      boot.current.receive(event);
    }
  });
  const parsedConfig = parseVisualOuterConfig(config.textContent);
  if (parsedConfig.isErr()) {
    throw parsedConfig.error;
  }
  const { origins, policy } = parsedConfig.value;
  const inner = document.createElement("iframe");
  inner.setAttribute("sandbox", "allow-scripts");
  inner.setAttribute("referrerpolicy", "no-referrer");
  document.body.append(inner);
  let latestTheme: VisualTheme | undefined;
  const sendTheme = () => {
    if (latestTheme) {
      inner.contentWindow?.postMessage(
        { kind: "theme", theme: latestTheme },
        "*",
      );
    }
  };
  inner.addEventListener("load", sendTheme);
  const receive = createVisualMessageHandler({
    parentWindow: window.parent,
    innerWindow: inner.contentWindow,
    outerOrigin: window.location.origin,
    origins,
    onRender: ({ title, html, data, theme }) => {
      latestTheme = theme;
      inner.title = title;
      // safe-html: sanitizeVisualHtml output validated at the message boundary, composed with Stella's bundled runtime and fixed policy.
      inner.srcdoc = composeVisualDocument({
        html,
        data,
        runtime,
        policy,
        theme,
      });
    },
    onTheme: (theme) => {
      latestTheme = theme;
      sendTheme();
    },
    onGuestMessage: (message, hostOrigin) =>
      window.parent.postMessage(message, hostOrigin),
    // An engine without the API fails closed: the view still renders, but
    // its actions never reach the app.
    hasUserActivation: () =>
      "userActivation" in navigator && navigator.userActivation.isActive,
    now: () => performance.now(),
  });
  boot.current = { type: "ready", receive };
  const reportReady = () => {
    const message = visualShellReadyMessage(window.location.hash);
    if (message !== null) {
      window.parent.postMessage(message, "*");
    }
  };
  window.addEventListener("hashchange", reportReady);
  reportReady();
};

const runtime = document.currentScript?.textContent;
if (runtime) {
  if (document.documentElement.hasAttribute(VISUAL_GUEST_MARKER_ATTRIBUTE)) {
    bootGuest();
  } else {
    bootOuter(runtime);
  }
}
