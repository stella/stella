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

import { createVisualMessageHandler } from "../bridge";
import { composeVisualDocument } from "../srcdoc";
import { parseVisualOuterConfig, whenVisualDocumentReady } from "./boot";
import { createVisualGuestApi } from "./guest-api";
import { isolateVisualGuest } from "./isolation";
import { installVisualPresentation } from "./presentation";
import { visualShellReadyMessage } from "./shell-ready";

const bootGuest = () => {
  try {
    isolateVisualGuest();
    installVisualPresentation(document);
    const dataElement = document.querySelector(`#${VISUAL_DATA_SCRIPT_ID}`);
    if (!dataElement) {
      return panic("The visual document has no data payload");
    }
    const data = v.parse(
      generatedVisualInputSchema.entries.data,
      JSON.parse(dataElement.textContent),
    );
    Object.defineProperty(window, "stella", {
      value: createVisualGuestApi({
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
      writable: false,
      configurable: false,
    });
  } catch (error) {
    window.stop();
    document.documentElement.replaceChildren();
    throw error;
  }
  const NativeElement = Element;
  const closest = Element.prototype.closest;
  const getAttribute = Element.prototype.getAttribute;
  const requestLink = (event: Event) => {
    if (!(event.target instanceof NativeElement)) {
      return;
    }
    const anchor = closest.call(event.target, "a[data-stella-link]");
    if (!anchor) {
      return;
    }
    event.preventDefault();
    const parsed = v.safeParse(
      visualLinkSchema,
      getAttribute.call(anchor, "data-stella-link"),
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
  const parsedConfig = parseVisualOuterConfig(config.textContent);
  if (parsedConfig.isErr()) {
    throw parsedConfig.error;
  }
  const { origins, policy } = parsedConfig.value;
  const inner = document.createElement("iframe");
  inner.setAttribute("sandbox", "allow-scripts");
  inner.setAttribute("referrerpolicy", "no-referrer");
  document.body.append(inner);
  window.addEventListener(
    "message",
    createVisualMessageHandler({
      parentWindow: window.parent,
      innerWindow: inner.contentWindow,
      outerOrigin: window.location.origin,
      origins,
      onRender: ({ title, html, data }) => {
        inner.title = title;
        // safe-html: sanitizeVisualHtml output validated at the message boundary, composed with Stella's bundled runtime and fixed policy.
        inner.srcdoc = composeVisualDocument({ html, data, runtime, policy });
      },
      onGuestMessage: (message, hostOrigin) =>
        window.parent.postMessage(message, hostOrigin),
    }),
  );
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
