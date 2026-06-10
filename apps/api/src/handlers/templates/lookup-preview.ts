import { Result } from "better-result";
import { t } from "elysia";

import type { LookupOutcome } from "@/api/handlers/docx/lookup-fields";
import {
  createDispatchLookupResolver,
  isPlausibleLookupValue,
  LOOKUP_REGISTRY_NAMES,
  renderLookupOutput,
} from "@/api/handlers/docx/lookup-fields";
import { LOOKUP_REGISTRIES } from "@/api/handlers/docx/types";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const lookupPreviewBodySchema = t.Object({
  registry: t.UnionEnum(LOOKUP_REGISTRIES),
  number: t.String({ maxLength: 64 }),
  /** The field's format template; null/empty = deterministic "name, seat". */
  format: t.Nullable(t.String({ maxLength: 2000 })),
});

const config = {
  permissions: { workspace: ["read"] },
  body: lookupPreviewBodySchema,
} satisfies HandlerConfig;

// Process-lifetime cache of resolved outcomes per (registry, number): the
// studio preview re-resolves the same numbers on every keystroke session and
// the upstream registries are slow. Hits and not-founds are kept (registry
// data churn is irrelevant at preview granularity); transient upstream errors
// are not, so a blip does not stick. Bounded: at most
// LOOKUP_PREVIEW_CACHE_MAX entries, evicting the oldest insertion, so memory
// stays capped regardless of process lifetime.
const LOOKUP_PREVIEW_CACHE_MAX = 500;
const outcomeCache = new Map<string, LookupOutcome>();

const rememberOutcome = (key: string, outcome: LookupOutcome): void => {
  if (outcome.type === "error") {
    return;
  }
  if (outcomeCache.size >= LOOKUP_PREVIEW_CACHE_MAX) {
    const oldest = outcomeCache.keys().next().value;
    if (oldest !== undefined) {
      outcomeCache.delete(oldest);
    }
  }
  outcomeCache.set(key, outcome);
};

const resolveLookup = createDispatchLookupResolver();

/**
 * Deterministic live preview of a registry-lookup field: number → registry
 * hit → the field's `[token]` format rendered as text. `rendered` carries the
 * format's `**bold**` / `*italic*` markers verbatim (the marker grammar in
 * docx/lookup-fields.ts); the client decides presentation — the studio
 * parses them into formatted preview runs. No AI is involved on this path.
 */
const lookupPreview = createSafeRootHandler(config, async function* ({ body }) {
  const { registry, format } = body;
  const number = body.number.trim();
  const registryName = LOOKUP_REGISTRY_NAMES[registry];

  if (!isPlausibleLookupValue(registry, number)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `"${number}" is not a valid ${registryName} number.`,
      }),
    );
  }

  const cacheKey = `${registry}:${number.replaceAll(/\s/gu, "")}`;
  let outcome = outcomeCache.get(cacheKey);
  if (outcome === undefined) {
    // The per-registry adapters own timeouts on their upstream calls.
    outcome = yield* Result.await(
      Result.tryPromise({
        try: async () => await resolveLookup({ registry, query: number }),
        catch: (cause) =>
          new HandlerError({
            status: 502,
            message: `${registryName} lookup failed`,
            cause,
          }),
      }),
    );
    rememberOutcome(cacheKey, outcome);
  }

  if (outcome.type === "not-found") {
    return Result.err(
      new HandlerError({
        status: 404,
        message: `No company found in ${registryName} for "${number}".`,
      }),
    );
  }
  if (outcome.type === "error") {
    return Result.err(
      new HandlerError({
        status: 502,
        message: `${registryName} lookup failed: ${outcome.message}`,
      }),
    );
  }

  return Result.ok({ rendered: renderLookupOutput(format, outcome.hit) });
});

export default lookupPreview;
