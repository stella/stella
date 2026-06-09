/**
 * Registry lookup fields.
 *
 * A manifest field with `lookup` is filled by entering only the registry
 * number (e.g. a 10-digit KRS number); at fill time the company is resolved
 * via the shared business-registry dispatch and the marker is filled with the
 * rendered company details. With an `aiFormat` instruction and a model
 * provider, AI formats the hit per the instruction ("[company name], with its
 * seat in [seat], KRS [number]"); otherwise a deterministic "name, seat"
 * rendering is used.
 *
 * The resolution and formatting dependencies are injected so the module stays
 * testable without network or model access; {@link createDispatchLookupResolver}
 * wires the real dispatch table for the fill boundaries. A lookup that fails
 * (malformed number, no match, upstream error) rejects the request at the
 * boundary with a message naming the field — silently passing the raw number
 * into the document would be worse than an actionable error.
 */

import { validateKrsNumber } from "@stll/business-registries/krs";
import { resolvePath } from "@stll/template-conditions";

import type {
  BusinessRegistryHit,
  RegistryHandler,
} from "@/api/lib/business-registries/dispatch";
import {
  BUSINESS_REGISTRY_DISPATCH,
  executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";

import { replaceResolvedValue } from "./composite-fields";
import type { FieldMeta, LookupRegistry } from "./types";

// ── Registry-number plausibility ─────────────────────────

/** Per-registry number validation, reusing the package validators (KRS is a
 *  pure shape check: 10 digits, no checksum). */
const LOOKUP_VALUE_VALIDATORS: Record<
  LookupRegistry,
  (input: string) => boolean
> = {
  krs: validateKrsNumber,
};

/** Human-readable registry names for error messages. */
const LOOKUP_REGISTRY_NAMES: Record<LookupRegistry, string> = {
  krs: "KRS",
};

/** True when the submitted value has the shape of the registry's canonical
 *  number (whitespace-tolerant; semantic existence is checked by the lookup). */
export const isPlausibleLookupValue = (
  registry: LookupRegistry,
  value: string,
): boolean => LOOKUP_VALUE_VALIDATORS[registry](value);

// ── Lookup resolution (injected) ─────────────────────────

export type LookupOutcome =
  | { type: "hit"; hit: BusinessRegistryHit }
  | { type: "not-found" }
  | { type: "error"; message: string };

export type LookupResolver = (input: {
  registry: LookupRegistry;
  query: string;
}) => Promise<LookupOutcome>;

/**
 * AI formatter for a lookup hit (FieldMeta.lookup.aiFormat). Returns the
 * formatted string, or `undefined` when no model is available or the model
 * fails — callers fall back to {@link renderLookupHit}.
 */
export type AiLookupFormatter = (input: {
  instruction: string;
  fieldPath: string;
  hit: BusinessRegistryHit;
}) => Promise<string | undefined>;

/**
 * The real resolver over the shared registry dispatch. The per-registry
 * adapters own timeouts (`AbortSignal.timeout`) on their upstream calls.
 * The dispatch table is injectable for tests (mirroring how dispatch.test.ts
 * stubs handlers); production callers use the default.
 */
export const createDispatchLookupResolver =
  (
    dispatch: Record<
      LookupRegistry,
      RegistryHandler
    > = BUSINESS_REGISTRY_DISPATCH,
  ): LookupResolver =>
  async ({ registry, query }) => {
    const response = await executeRegistryLookup({
      handler: dispatch[registry],
      query,
    });
    if (response instanceof Error) {
      return { type: "error", message: response.message };
    }
    if (response.type !== "lookup" || response.hit === null) {
      return { type: "not-found" };
    }
    return { type: "hit", hit: response.hit };
  };

// ── Deterministic rendering ──────────────────────────────

/** Deterministic "name, seat" rendering of a hit, used when no AI format
 *  instruction is set or no model is available. */
export const renderLookupHit = (hit: BusinessRegistryHit): string => {
  const seat = hit.address?.textAddress ?? hit.address?.city ?? null;
  return [hit.name, seat].filter((part) => part !== null).join(", ");
};

// ── Resolution over manifest fields ──────────────────────

export type LookupFieldError = {
  /** Manifest path of the lookup field. */
  path: string;
  message: string;
};

export type LookupResolution =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: LookupFieldError[] };

/**
 * Resolve every lookup field's submitted registry number into the rendered
 * company details. An absent or empty value is left for the fill's
 * required/unmatched diagnostics; a malformed number, a number with no match,
 * or an upstream failure produces an error naming the field.
 */
export const resolveLookupFields = async ({
  values,
  fields,
  resolve,
  formatWithAi,
}: {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
  resolve: LookupResolver;
  formatWithAi?: AiLookupFormatter | undefined;
}): Promise<LookupResolution> => {
  const lookupFields = fields.filter((field) => field.lookup !== undefined);
  if (lookupFields.length === 0) {
    return { ok: true, values };
  }

  const resolved: Record<string, unknown> = { ...values };
  const errors: LookupFieldError[] = [];

  for (const field of lookupFields) {
    const lookup = field.lookup;
    if (lookup === undefined) {
      continue;
    }
    const incoming = resolvePath(field.path, resolved);
    if (typeof incoming !== "string" || incoming.trim() === "") {
      continue;
    }

    const registryName = LOOKUP_REGISTRY_NAMES[lookup.registry];
    if (!isPlausibleLookupValue(lookup.registry, incoming)) {
      errors.push({
        path: field.path,
        message: `Field "${field.path}": "${incoming}" is not a valid ${registryName} number.`,
      });
      continue;
    }

    const outcome = await resolve({
      registry: lookup.registry,
      query: incoming,
    });
    if (outcome.type === "not-found") {
      errors.push({
        path: field.path,
        message: `Field "${field.path}": no company found in ${registryName} for "${incoming}".`,
      });
      continue;
    }
    if (outcome.type === "error") {
      errors.push({
        path: field.path,
        message: `Field "${field.path}": ${registryName} lookup failed: ${outcome.message}`,
      });
      continue;
    }

    const aiFormatted =
      lookup.aiFormat !== undefined &&
      lookup.aiFormat.trim() !== "" &&
      formatWithAi !== undefined
        ? await formatWithAi({
            instruction: lookup.aiFormat,
            fieldPath: field.path,
            hit: outcome.hit,
          })
        : undefined;
    replaceResolvedValue(
      resolved,
      field.path,
      aiFormatted ?? renderLookupHit(outcome.hit),
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, values: resolved };
};

/**
 * Boundary convenience for the fill handlers: resolve lookup values in place
 * and return the combined validation message, or null when every lookup
 * resolved (or there is no manifest).
 */
export const applyLookupFields = async (
  values: Record<string, unknown>,
  manifest: { fields: FieldMeta[] } | null,
  options: {
    resolve: LookupResolver;
    formatWithAi?: AiLookupFormatter | undefined;
  },
): Promise<string | null> => {
  if (!manifest) {
    return null;
  }
  const resolution = await resolveLookupFields({
    values,
    fields: manifest.fields,
    resolve: options.resolve,
    formatWithAi: options.formatWithAi,
  });
  if (!resolution.ok) {
    return resolution.errors.map((e) => e.message).join(" ");
  }
  for (const [key, value] of Object.entries(resolution.values)) {
    values[key] = value;
  }
  return null;
};
