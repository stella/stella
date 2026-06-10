/**
 * Registry lookup fields.
 *
 * A manifest field with `lookup` is filled by entering only the registry
 * number (e.g. a 10-digit KRS number); at fill time the company is resolved
 * via the shared business-registry dispatch and the marker is filled with the
 * rendered company details. With an author's format template, the [token]
 * slots ("[company name], with its seat in [seat], KRS [registry number]")
 * are substituted deterministically from the hit; otherwise a deterministic
 * "name, seat" rendering is used. Grammar and wording adjustments are not the
 * lookup's job: they happen downstream in the per-occurrence aiAdapt pass.
 *
 * The resolution dependency is injected so the module stays testable
 * without network access; {@link createDispatchLookupResolver}
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
import type {
  FieldMeta,
  LookupRegistry,
  RichPatchValue,
  RichRun,
} from "./types";

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
export const LOOKUP_REGISTRY_NAMES: Record<LookupRegistry, string> = {
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

/** Deterministic "name, seat" rendering of a hit, used when the field has no
 *  format template (or the template renders empty). */
export const renderLookupHit = (hit: BusinessRegistryHit): string => {
  const seat = hit.address?.textAddress ?? hit.address?.city ?? null;
  return [hit.name, seat].filter((part) => part !== null).join(", ");
};

/** The [token] names the config UI offers, mapped onto hit fields. The
 *  baseline tokens come from the cross-registry hit; the rest narrow on the
 *  per-registry details payload. */
const lookupTemplateTokens = (
  hit: BusinessRegistryHit,
): Record<string, string | null | undefined> => {
  const tokens: Record<string, string | null | undefined> = {
    "company name": hit.name,
    "legal form": hit.legalForm,
    seat: hit.address?.city ?? null,
    address: hit.address?.textAddress ?? null,
  };
  const details = hit.details;
  if (details !== undefined && details.registry === "krs") {
    const { entity } = details;
    tokens["registry number"] = entity.krsNumber;
    tokens["NIP"] = entity.identifiers.nip;
    tokens["REGON"] = entity.identifiers.regon;
    tokens["share capital"] =
      entity.shareCapital === null
        ? null
        : `${entity.shareCapital.amount} ${entity.shareCapital.currency}`;
  }
  return tokens;
};

/** Deterministic rendering of the author's format template: [tokens] are
 *  substituted from the hit; unknown or missing tokens render empty. */
export const renderLookupTemplate = (
  template: string,
  hit: BusinessRegistryHit,
): string => {
  const tokens = lookupTemplateTokens(hit);
  return template
    .replace(
      /\[([^[\]]{1,64})\]/gu,
      (_match, raw: string) => tokens[raw.trim()] ?? "",
    )
    .replace(/ {2,}/gu, " ")
    .trim();
};

/** The rendered output for a hit: the author's format template when present
 *  (with its `**bold**` / `*italic*` markers intact — the consumer decides
 *  how to interpret them), falling back to the deterministic "name, seat"
 *  when there is no template or it renders empty. */
export const renderLookupOutput = (
  format: string | null | undefined,
  hit: BusinessRegistryHit,
): string => {
  const template = format?.trim() ?? "";
  const rendered = template === "" ? "" : renderLookupTemplate(template, hit);
  return rendered !== "" ? rendered : renderLookupHit(hit);
};

// ── Inline markdown in the rendered output ───────────────

/** `**bold**` / `*italic*` spans in the author's format template. Spans do
 *  not nest and cannot contain asterisks, and an italic `*` never pairs
 *  against a `**` delimiter (lookarounds); anything unmatched (a stray `*`,
 *  empty `****`, an asterisk inside a substituted value) stays literal. */
const LOOKUP_MARKDOWN_RE = /\*\*([^*]+)\*\*|(?<!\*)\*([^*]+)\*(?!\*)/gu;

/**
 * Parse a rendered lookup output into formatted runs: `**bold**` and
 * `*italic*` spans become correspondingly formatted runs, everything else
 * stays a plain run. Unmatched asterisks are left literal.
 */
export const parseLookupMarkdown = (text: string): RichRun[] => {
  const runs: RichRun[] = [];
  let cursor = 0;
  for (const match of text.matchAll(LOOKUP_MARKDOWN_RE)) {
    if (match.index > cursor) {
      runs.push({ text: text.slice(cursor, match.index) });
    }
    const [, bold, italic] = match;
    if (bold !== undefined) {
      runs.push({ text: bold, bold: true });
    } else if (italic !== undefined) {
      runs.push({ text: italic, italic: true });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    runs.push({ text: text.slice(cursor) });
  }
  return runs;
};

/** Plain text of a rendered lookup output with the `**` / `*` formatting
 *  markers removed — the live-preview path renders plain text only. */
export const stripLookupMarkdown = (text: string): string =>
  parseLookupMarkdown(text)
    .map((run) => run.text)
    .join("");

/** The fill value for a rendered lookup output: a rich multi-run patch when
 *  the author used `**bold**` / `*italic*` in the format template (the patch
 *  engine renders the runs with the marker run's other formatting intact),
 *  otherwise the plain string. */
export const lookupValueFromRendered = (text: string): RichPatchValue => {
  const runs = parseLookupMarkdown(text);
  if (!runs.some((run) => run.bold === true || run.italic === true)) {
    return text;
  }
  return { paragraphs: [{ runs }] };
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
}: {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
  resolve: LookupResolver;
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

    // The registry is resolved once; every format renders that one hit. The
    // author's templates render deterministically ([tokens] substituted from
    // the hit); grammar and wording adjustments happen downstream in the
    // per-occurrence aiAdapt pass, never at lookup time.
    const renderHit = (format: string | null | undefined): RichPatchValue => {
      const text = renderLookupOutput(format, outcome.hit);
      // The aiAdapt pass rewrites plain string stubs only, so a Person + AI
      // lookup keeps a plain value (formatting markers stripped); otherwise
      // **bold** / *italic* spans in the format become formatted runs.
      return field.aiAdapt === true
        ? stripLookupMarkdown(text)
        : lookupValueFromRendered(text);
    };

    // The formats list is non-empty (isFieldLookup invariant). The first
    // format is the default for the bare `{{company}}` marker (or its nested
    // `company.value`); every later format is a keyed `{{company.<key>}}`
    // rendering of the SAME hit. The keyed values are written as a FLAT dotted
    // key so the marker resolves them directly (the base value at `field.path`
    // is a string, so a nested walk would miss `<key>`); duplicate keys keep
    // the last template.
    for (const [index, format] of lookup.formats.entries()) {
      const value = renderHit(format.template);
      if (index === 0) {
        replaceResolvedValue(resolved, field.path, value);
        continue;
      }
      resolved[`${field.path}.${format.key}`] = value;
    }
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
  },
): Promise<string | null> => {
  if (!manifest) {
    return null;
  }
  const resolution = await resolveLookupFields({
    values,
    fields: manifest.fields,
    resolve: options.resolve,
  });
  if (!resolution.ok) {
    return resolution.errors.map((e) => e.message).join(" ");
  }
  for (const [key, value] of Object.entries(resolution.values)) {
    values[key] = value;
  }
  return null;
};
