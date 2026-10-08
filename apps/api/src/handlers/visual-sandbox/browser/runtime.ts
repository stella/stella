import { panic } from "better-result";
import * as v from "valibot";

import {
  VISUAL_DATA_SCRIPT_ID,
  generatedVisualInputSchema,
} from "@stll/api-contract/generated-visual";
import {
  VISUAL_GUEST_MARKER_ATTRIBUTE,
  VISUAL_RENDER_ID_SCRIPT_ID,
  VISUAL_SANDBOX_LIMITS,
  visualGuestPortMessageSchema,
  visualLinkSchema,
} from "@stll/api-contract/visual-sandbox";
import {
  VISUAL_THEME_SCRIPT_ID,
  visualThemeSchema,
  type VisualTheme,
} from "@stll/api-contract/visual-theme";

import { createVisualMessageHandler, visualGuestPortFrom } from "../bridge";
import { composeVisualDocument } from "../srcdoc";
import { parseVisualOuterConfig, whenVisualDocumentReady } from "./boot";
import { createVisualCharts } from "./charts";
import { createVisualGuestApi } from "./guest-api";
import { createVisualGestureGate } from "./guest-gesture";
import { createVisualThemeHandler } from "./guest-theme";
import { isolateVisualGuest } from "./isolation";
import { applyVisualTheme, installVisualPresentation } from "./presentation";
import { visualShellReadyMessage } from "./shell-ready";

const bootGuest = (): void => {
  // This runs before any page script. Every message to the shell travels on
  // a private port whose sender is captured here, so page script can neither
  // reach the port nor replace how it sends. The shell binds only the first
  // port a view hands over for its render and ignores view messages sent to
  // the window.
  const channel = new MessageChannel();
  const send = channel.port1.postMessage.bind(channel.port1);
  const gesture = createVisualGestureGate({
    now: performance.now.bind(performance),
  });
  gesture.listen(window);
  try {
    const renderIdElement = document.querySelector(
      `#${VISUAL_RENDER_ID_SCRIPT_ID}`,
    );
    if (!renderIdElement) {
      panic("The visual document has no render id");
    }
    const renderId = v.parse(
      visualGuestPortMessageSchema.entries.renderId,
      JSON.parse(renderIdElement.textContent),
    );
    window.parent.postMessage(
      { kind: "port", renderId } satisfies v.InferOutput<
        typeof visualGuestPortMessageSchema
      >,
      "*",
      [channel.port2],
    );
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
          postMessage: (message) => send(message),
          takeGesture: gesture.take,
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
    if (parsed.success && gesture.take()) {
      send({ kind: "open-link", url: parsed.output });
    }
  };
  document.addEventListener("click", requestLink);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      requestLink(event);
    }
  });
  const reportSize = () =>
    send({
      kind: "resize",
      height: Math.max(
        1,
        Math.min(
          VISUAL_SANDBOX_LIMITS.height,
          Math.ceil(document.documentElement.scrollHeight),
        ),
      ),
    });
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
      boot.current.receive({
        source: event.source,
        origin: event.origin,
        data: event.data,
        ports: event.ports.map(visualGuestPortFrom),
      });
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
    onRender: ({ renderId, title, html, data, theme }) => {
      latestTheme = theme;
      inner.title = title;
      // safe-html: sanitizeVisualHtml output validated at the message boundary, composed with Stella's bundled runtime and fixed policy.
      inner.srcdoc = composeVisualDocument({
        html,
        data,
        renderId,
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
    createRenderId: () => crypto.randomUUID(),
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
