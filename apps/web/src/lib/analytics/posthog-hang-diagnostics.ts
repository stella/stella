import { Result } from "better-result";
import type { CaptureResult } from "posthog-js";

import { pickIngestionRequired } from "@/lib/analytics/posthog-ingestion";
import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";
import { isPersistedUiStateFingerprintKey } from "@/lib/persisted-ui-state";
import { WEB_ROUTE_TEMPLATES } from "@/route-templates.gen";

const BUILD = /^[\w.+-]{1,100}$/u;
const STATIC_SCRIPT = /^\/assets\/[\w.-]{1,200}\.m?js$/u;
const MAX_SCRIPTS = 10;
const MAX_FRAME_DURATION = 60 * 60 * 1000;
const SAFE_INVOKERS = new Set([
  "Window.requestAnimationFrame",
  "Window.setTimeout",
  "Window.setInterval",
  "Window.requestIdleCallback",
  "Response.json",
  "Promise.then",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const staticScriptUrl = (
  value: unknown,
  origin: string,
): string | undefined => {
  if (typeof value !== "string" || value.length > 2048) {
    return undefined;
  }
  const parsed = Result.try(() => new URL(value, origin)).unwrapOr(undefined);
  if (
    parsed === undefined ||
    parsed.origin !== origin ||
    !STATIC_SCRIPT.test(parsed.pathname)
  ) {
    return undefined;
  }
  return `${parsed.origin}${parsed.pathname}`;
};

const sanitizeScripts = (value: unknown, appUrl: string) => {
  const origin = Result.try(() => new URL(appUrl).origin).unwrapOr(undefined);
  if (origin === undefined) {
    return [];
  }
  const scripts: unknown[] = Array.isArray(value) ? value : [];
  return scripts.slice(0, MAX_SCRIPTS).flatMap((script) => {
    if (!isRecord(script)) {
      return [];
    }
    const sourceURL = staticScriptUrl(script["sourceURL"], origin);
    if (sourceURL === undefined) {
      return [];
    }
    const invoker = script["invoker"];
    return [
      {
        sourceURL,
        invoker:
          typeof invoker === "string" && SAFE_INVOKERS.has(invoker)
            ? invoker
            : "?",
        // Engines infer function names from computed keys, including user content.
        sourceFunctionName: "?",
      },
    ];
  });
};

export const sanitizeHangDiagnosticEvent = (
  event: CaptureResult,
  appUrl: string,
): CaptureResult | null => {
  const properties: Record<string, unknown> = event.properties;
  if (event.event === WEB_ANALYTICS_EVENTS.longAnimationFrame) {
    const duration = properties["duration"];
    if (
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration <= 1000 ||
      duration > MAX_FRAME_DURATION
    ) {
      return null;
    }
    return {
      ...event,
      properties: {
        ...pickIngestionRequired(properties),
        duration,
        scripts: sanitizeScripts(properties["scripts"], appUrl),
      },
    };
  }
  const routeTemplate = properties["routeTemplate"];
  const phase = properties["phase"];
  const build = properties["build"];
  const restoredState = properties["restoredState"];
  if (
    typeof routeTemplate !== "string" ||
    (routeTemplate !== "unknown" &&
      !WEB_ROUTE_TEMPLATES.some((template) => template === routeTemplate)) ||
    (phase !== "boot" && phase !== "session") ||
    typeof build !== "string" ||
    !BUILD.test(build) ||
    !Array.isArray(restoredState)
  ) {
    return null;
  }
  const entries: unknown[] = restoredState;
  const fingerprint = entries.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const key = entry["key"];
    const bytes = entry["bytes"];
    if (
      typeof key !== "string" ||
      !isPersistedUiStateFingerprintKey(key) ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    ) {
      return [];
    }
    return [{ key, bytes }];
  });
  return {
    ...event,
    properties: {
      ...pickIngestionRequired(properties),
      routeTemplate,
      phase,
      build,
      restoredState: fingerprint,
    },
  };
};
