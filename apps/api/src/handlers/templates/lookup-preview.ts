import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { getOrganizationRegistryHandler } from "@/api/lib/business-registries/credentials";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import {
  createDispatchLookupResolver,
  isPlausibleLookupValue,
  lookupRegistryName,
  renderLookupOutput,
} from "@/api/lib/docx/lookup-fields";
import { LOOKUP_REGISTRIES } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { getLookupPreviewOutcome } from "./lookup-preview-cache";

const lookupPreviewBodySchema = t.Object({
  registry: t.UnionEnum(LOOKUP_REGISTRIES),
  number: t.String({ maxLength: 64 }),
  /** The field's format template; null/empty = deterministic "name, seat". */
  format: t.Nullable(t.String({ maxLength: 2000 })),
});

const config = {
  description:
    "Preview a registry-lookup field: resolve a company number against the " +
    "chosen public register and render the field's format string over the " +
    "hit, returning the text with its bold and italic markers left in place " +
    "for the client to interpret. Refused when the number is not plausible " +
    "for that register or required credentials are missing, and " +
    "a 404 when the company is not found. Outcomes are cached per register " +
    "and number, and no model is involved.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  access: "read",
  body: lookupPreviewBodySchema,
} satisfies HandlerConfig;

/**
 * Deterministic live preview of a registry-lookup field: number → registry
 * hit → the field's `[token]` format rendered as text. `rendered` carries the
 * format's `**bold**` / `*italic*` markers verbatim (the marker grammar in
 * docx/lookup-fields.ts); the client decides presentation — the studio
 * parses them into formatted preview runs. No AI is involved on this path.
 */
const lookupPreview = createSafeRootHandler(
  config,
  async function* ({ body, scopedDb, session }) {
    const { registry, format } = body;
    const number = body.number.trim();
    const registryName = lookupRegistryName(registry);

    if (!isPlausibleLookupValue(registry, number)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `"${number}" is not a valid ${registryName} number.`,
        }),
      );
    }

    const handler = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await getOrganizationRegistryHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            registry,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not load registry configuration",
            cause,
          }),
      }),
    );
    if (!handler.isDeployAvailable()) {
      return Result.err(
        new HandlerError({
          status: 428,
          code: "registry_configuration_required",
          message: `Configure credentials for ${registryName} to preview the specification`,
        }),
      );
    }
    const resolveLookup = createDispatchLookupResolver({
      dispatch: { ...BUSINESS_REGISTRY_DISPATCH, [registry]: handler },
    });
    const cacheKey = `${session.activeOrganizationId}:${registry}:${handler.cacheVersion ?? "deployment"}:${number.replaceAll(/\s/gu, "")}`;
    const outcome = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await getLookupPreviewOutcome({
            key: cacheKey,
            // The per-registry adapters own timeouts on their upstream calls.
            load: async () => await resolveLookup({ registry, query: number }),
          }),
        catch: (cause) =>
          new HandlerError({
            status: 502,
            message: `${registryName} lookup failed`,
            cause,
          }),
      }),
    );

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
  },
);

export default lookupPreview;
