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

import { validateIco as validateAresIco } from "@stll/business-registries/ares";
import { validateOrgnr } from "@stll/business-registries/brreg";
import { validateCompanyNumber } from "@stll/business-registries/companies-house";
import { validateCik } from "@stll/business-registries/edgar";
import { validateTaxId } from "@stll/business-registries/gcis";
import { validateKrsNumber } from "@stll/business-registries/krs";
import { validateIco as validateOrsrIco } from "@stll/business-registries/orsr";
import { validateBusinessId } from "@stll/business-registries/prh";
import { hasCanonicalShape as hasRechercheEntreprisesShape } from "@stll/business-registries/recherche-entreprises";
import { validateVatFormat } from "@stll/business-registries/vies";
import { assertNever, resolvePath } from "@stll/template-conditions";

import type {
  BusinessRegistryHit,
  RegistryHandler,
} from "@/api/lib/business-registries/dispatch";
import {
  BUSINESS_REGISTRY_DISPATCH,
  executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";

import { replaceResolvedValue } from "./composite-fields";
import {
  mapRepeatablePath,
  readRowSubPath,
  writeRowSubPath,
} from "./repeatable-paths";
import type {
  FieldLookup,
  FieldMeta,
  LookupRegistry,
  RichPatchValue,
  RichRun,
} from "./types";

// ── Registry-number plausibility ─────────────────────────

/** Per-registry number validation, reusing the package validators. Each is a
 *  cheap structural/checksum check on the submitted identifier; semantic
 *  existence is settled by the lookup itself. */
const LOOKUP_VALUE_VALIDATORS: Record<
  LookupRegistry,
  (input: string) => boolean
> = {
  ares: validateAresIco,
  brreg: validateOrgnr,
  "companies-house": validateCompanyNumber,
  edgar: validateCik,
  gcis: validateTaxId,
  krs: validateKrsNumber,
  orsr: validateOrsrIco,
  prh: validateBusinessId,
  "recherche-entreprises": hasRechercheEntreprisesShape,
  vies: validateVatFormat,
};

/** Human-readable registry names for error messages. */
export const LOOKUP_REGISTRY_NAMES: Record<LookupRegistry, string> = {
  ares: "ARES",
  brreg: "BRREG",
  "companies-house": "Companies House",
  edgar: "SEC EDGAR",
  gcis: "GCIS",
  krs: "KRS",
  orsr: "ORSR",
  prh: "PRH",
  "recherche-entreprises": "RNE",
  vies: "VIES",
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
 * Predicate gating a registry against the org's native-tool settings, by the
 * handler's `nativeToolSlug`. Mirrors the org-enabled check the contacts
 * lookup route enforces, threaded into the fill resolver so a template cannot
 * invoke a registry the organization has disabled. Async so the handler
 * boundary can construct it from a one-shot org-settings read.
 *
 * Omitting it (the default) skips org gating: tests and any internal/system
 * caller without an org context resolve as before. The gate is additive — a
 * caller WITH an org context passes this in to deny disabled registries.
 */
export type IsRegistryEnabledForOrg = (
  registry: LookupRegistry,
) => boolean | Promise<boolean>;

type CreateDispatchLookupResolverOptions = {
  dispatch?: Record<LookupRegistry, RegistryHandler>;
  isRegistryEnabledForOrg?: IsRegistryEnabledForOrg;
};

/**
 * The real resolver over the shared registry dispatch. The per-registry
 * adapters own timeouts (`AbortSignal.timeout`) on their upstream calls.
 * The dispatch table is injectable for tests (mirroring how dispatch.test.ts
 * stubs handlers); production callers use the default.
 *
 * `isRegistryEnabledForOrg`, when supplied, gates each lookup on the org's
 * native-tool settings before any upstream call. Constructed at the handler
 * boundary where org context exists; omitted on internal/test paths.
 */
export const createDispatchLookupResolver =
  ({
    dispatch = BUSINESS_REGISTRY_DISPATCH,
    isRegistryEnabledForOrg,
  }: CreateDispatchLookupResolverOptions = {}): LookupResolver =>
  async ({ registry, query }) => {
    const handler = dispatch[registry];
    // Mirror the contacts lookup route: never call a registry whose deployment
    // credentials are not configured (e.g. Companies House / EDGAR in a
    // self-hosted or test env). A template may offer every registry, but at
    // fill time an unavailable one fails clearly instead of surfacing an
    // upstream configuration error.
    if (!handler.isDeployAvailable()) {
      return {
        type: "error",
        message: `The ${registry} registry is not available in this deployment.`,
      };
    }
    // Gate on the org's native-tool settings (when an org context was threaded
    // in), exactly like the contacts lookup route: a deployed-but-disabled
    // registry is refused here, before any upstream call.
    if (isRegistryEnabledForOrg && !(await isRegistryEnabledForOrg(registry))) {
      return {
        type: "error",
        message: `The ${registry} registry is disabled for this organization.`,
      };
    }
    const response = await executeRegistryLookup({ handler, query });
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

/** "court, section insert" court-file reference, or null when the registry
 *  filed none. Shared by the ARES (insert) and ORSR (insertNumber) variants. */
const formatCourtFile = (
  parts: { court: string; section: string; insert: string } | null,
): string | null =>
  parts === null ? null : `${parts.court}, ${parts.section} ${parts.insert}`;

/** The [token] names the config UI offers, mapped onto hit fields. The
 *  baseline tokens come from the cross-registry hit (every registry); the
 *  switch adds and overrides per-registry tokens from the typed `details`
 *  payload. Exhaustive over the discriminated union so a new registry forces
 *  a branch here. */
const lookupTemplateTokens = (
  hit: BusinessRegistryHit,
): Record<string, string | null | undefined> => {
  const tokens: Record<string, string | null | undefined> = {
    "company name": hit.name,
    "legal form": hit.legalForm,
    seat: hit.address?.city ?? null,
    address: hit.address?.textAddress ?? null,
    "registry number": hit.id,
    "postal code": hit.address?.postalCode ?? null,
    country: hit.address?.country ?? null,
  };
  const details = hit.details;
  if (details === undefined) {
    return tokens;
  }
  switch (details.registry) {
    case "ares": {
      const { company } = details;
      tokens["share capital"] = company.shareCapital;
      tokens["court file"] = formatCourtFile(company.courtFile);
      tokens["registered on"] = company.dateRegistered;
      tokens["acting clause"] = company.actingClause;
      break;
    }
    case "orsr": {
      const { company } = details;
      tokens["share capital"] = company.shareCapital;
      tokens["share capital paid"] = company.shareCapitalPaid;
      tokens["court file"] = company.courtFile
        ? formatCourtFile({
            court: company.courtFile.court,
            section: company.courtFile.section,
            insert: company.courtFile.insertNumber,
          })
        : null;
      tokens["registered on"] = company.establishedAt;
      tokens["acting clause"] = company.actingClause;
      break;
    }
    case "krs": {
      const { entity } = details;
      tokens["registry number"] = entity.krsNumber;
      tokens["NIP"] = entity.identifiers.nip;
      tokens["REGON"] = entity.identifiers.regon;
      tokens["share capital"] =
        entity.shareCapital === null
          ? null
          : `${entity.shareCapital.amount} ${entity.shareCapital.currency}`;
      tokens["registered on"] = entity.registeredAt;
      break;
    }
    case "companies-house": {
      const { company } = details;
      tokens["registry number"] = company.companyNumber;
      tokens["registered on"] = company.dateOfCreation;
      tokens["jurisdiction"] = company.jurisdiction;
      break;
    }
    case "brreg": {
      const { entity } = details;
      tokens["registry number"] = entity.orgnr;
      tokens["registered on"] = entity.registeredAt;
      break;
    }
    case "prh": {
      const { company } = details;
      tokens["registry number"] = company.businessId;
      tokens["registered on"] = company.registeredAt;
      break;
    }
    case "recherche-entreprises": {
      const { company } = details;
      // Keep the baseline `hit.id` for "registry number": the dispatch already
      // sets it to the matched establishment's SIRET (14 digits) for a branch
      // lookup, falling back to the SIREN — overriding with `company.siren`
      // would drop the SIRET that selected the address.
      tokens["registered on"] = company.registeredAt;
      break;
    }
    case "edgar": {
      const { company } = details;
      tokens["registry number"] = company.cik;
      tokens["EIN"] = company.ein;
      break;
    }
    case "gcis": {
      const { company } = details;
      tokens["registry number"] = company.taxId;
      tokens["registered on"] = company.setupDate;
      break;
    }
    case "vies": {
      const { validation } = details;
      tokens["VAT number"] =
        `${validation.vatNumber.country}${validation.vatNumber.vat}`;
      break;
    }
    default: {
      // Exhaustive over `BusinessRegistryHitDetails`: a new registry adds a
      // branch to the union and the compiler flags this `never` assignment.
      return assertNever(details);
    }
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
      /\[(?<token>[^[\]]{1,64})\]/gu,
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
const LOOKUP_MARKDOWN_RE =
  /\*\*(?<bold>[^*]+)\*\*|(?<!\*)\*(?<italic>[^*]+)\*(?!\*)/gu;

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
    if (incoming === undefined) {
      // A lookup field inside an `{{#each}}` loop keeps a dotted path
      // (`companies.krs`) while the value arrives as an array of rows
      // (`companies: [{ krs }]`); the direct `resolvePath` then returns
      // undefined, so each row's sub-path registry number is resolved and the
      // rendering(s) written back in place. Collect the rows first
      // (mapRepeatablePath is synchronous) and resolve them sequentially, since
      // resolution is an async, rate-limited external lookup.
      const rows: { row: Record<string, unknown>; subPath: string }[] = [];
      const mapped = mapRepeatablePath(
        resolved,
        field.path,
        ({ row, subPath }) => {
          rows.push({ row, subPath });
        },
      );
      if (mapped) {
        for (const { row, subPath } of rows) {
          // oxlint-disable-next-line no-await-in-loop -- sequential: rate-limited external registry lookup that appends to the shared `errors` accumulator
          await resolveLookupValue({
            lookup,
            aiAdapt: field.aiAdapt,
            path: field.path,
            incoming: readRowSubPath(row, subPath),
            resolve,
            errors,
            writeDefault: (value) => writeRowSubPath(row, subPath, value),
            writeKeyed: (key, value) => {
              // The keyed value is a FLAT dotted key on the row so the loop
              // expander's `registerItemPatchValues` flattens it to the
              // `{{companies.krs.<key>}}` marker (the base value at `subPath` is
              // a string, so a nested walk would miss `<key>`).
              row[`${subPath}.${key}`] = value;
            },
          });
        }
      }
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- sequential: rate-limited external registry lookup that appends to the shared `errors`/`resolved` accumulators
    await resolveLookupValue({
      lookup,
      aiAdapt: field.aiAdapt,
      path: field.path,
      incoming,
      resolve,
      errors,
      writeDefault: (value) =>
        replaceResolvedValue(resolved, field.path, value),
      // The keyed values are written as a FLAT dotted key so the marker
      // resolves them directly (the base value at `field.path` is a string, so
      // a nested walk would miss `<key>`); duplicate keys keep the last template.
      writeKeyed: (key, value) => {
        resolved[`${field.path}.${key}`] = value;
      },
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, values: resolved };
};

type ResolveLookupValueArgs = {
  lookup: FieldLookup;
  aiAdapt: boolean | undefined;
  /** Manifest path of the lookup field, used only for error messages. */
  path: string;
  /** The submitted registry number for this value (one field, or one loop row). */
  incoming: unknown;
  resolve: LookupResolver;
  errors: LookupFieldError[];
  /** Write the default-format rendering where the registry number was read. */
  writeDefault: (value: RichPatchValue) => void;
  /** Write a keyed-format rendering under its format key (`{{path.key}}`). */
  writeKeyed: (key: string, value: RichPatchValue) => void;
};

/**
 * Resolve one submitted registry number and write its rendering(s) back via the
 * supplied writers. Shared by the top-level path and the per-row repeatable
 * path so both validate, look up, and render identically; only where the value
 * is read/written differs. Pushes a field-named error (and writes nothing) on a
 * non-string, malformed, not-found, or failed value.
 */
const resolveLookupValue = async ({
  lookup,
  aiAdapt,
  path,
  incoming,
  resolve,
  errors,
  writeDefault,
  writeKeyed,
}: ResolveLookupValueArgs): Promise<void> => {
  if (typeof incoming !== "string" || incoming.trim() === "") {
    return;
  }

  const registryName = LOOKUP_REGISTRY_NAMES[lookup.registry];
  if (!isPlausibleLookupValue(lookup.registry, incoming)) {
    errors.push({
      path,
      message: `Field "${path}": "${incoming}" is not a valid ${registryName} number.`,
    });
    return;
  }

  const outcome = await resolve({ registry: lookup.registry, query: incoming });
  if (outcome.type === "not-found") {
    errors.push({
      path,
      message: `Field "${path}": no company found in ${registryName} for "${incoming}".`,
    });
    return;
  }
  if (outcome.type === "error") {
    errors.push({
      path,
      message: `Field "${path}": ${registryName} lookup failed: ${outcome.message}`,
    });
    return;
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
    return aiAdapt === true
      ? stripLookupMarkdown(text)
      : lookupValueFromRendered(text);
  };

  // The formats list is non-empty (isFieldLookup invariant). The first format
  // is the default for the bare `{{company}}` marker (or its nested
  // `company.value`); every later format is a keyed `{{company.<key>}}`
  // rendering of the SAME hit; duplicate keys keep the last template.
  for (const [index, format] of lookup.formats.entries()) {
    const value = renderHit(format.template);
    if (index === 0) {
      writeDefault(value);
      continue;
    }
    writeKeyed(format.key, value);
  }
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
