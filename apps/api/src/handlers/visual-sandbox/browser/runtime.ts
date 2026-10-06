import { panic } from "better-result";
import * as v from "valibot";

import { VISUAL_GUEST_MARKER_ATTRIBUTE, VISUAL_SANDBOX_LIMITS } from "@stll/api-contract/visual-sandbox";
import { VISUAL_DATA_SCRIPT_ID, generatedVisualInputSchema } from "@stll/api-contract/generated-visual";

import { createVisualMessageHandler } from "../bridge";
import { composeVisualDocument } from "../srcdoc";
import { createVisualGuestApi } from "./guest-api";
import { isolateVisualGuest } from "./isolation";

const bootGuest = () => {
  try {
    isolateVisualGuest();
    const dataElement = document.querySelector(`#${VISUAL_DATA_SCRIPT_ID}`);
    if (!dataElement) {
      return panic("The visual document has no data payload");
    }
    const data = v.parse(
      generatedVisualInputSchema.entries.data,
      JSON.parse(dataElement.textContent ?? ""),
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
  window.addEventListener(
    "DOMContentLoaded",
    () => {
      new ResizeObserver(reportSize).observe(document.body);
      reportSize();
    },
    { once: true },
  );
};

const bootOuter = (runtime: string) => {
  const config = document.querySelector("#visual-config");
  if (!config || window.self === window.top) {
    return;
  }
  const configSchema = v.strictObject({
    origins: v.array(v.string()),
    policy: v.string(),
  });
  const parsedConfig = v.safeParse(
    configSchema,
    JSON.parse(config.textContent),
  );
  if (!parsedConfig.success) {
    return;
  }
  const { origins, policy } = parsedConfig.output;
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
};

const runtime = document.currentScript?.textContent;
if (runtime) {
  if (document.documentElement.hasAttribute(VISUAL_GUEST_MARKER_ATTRIBUTE)) {
    bootGuest();
  } else {
    bootOuter(runtime);
  }
}
