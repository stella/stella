/**
 * The single template fill pipeline. Every fill boundary — the REST routes
 * (raw upload, by-id download, live preview, fill-to-workspace), the chat and
 * MCP tools, and the report exporter — resolves its source through here and
 * runs exactly one sequence: required-fields gate → clause slots → AI usage
 * preflight → manifest fill steps (lookups, composites, formulas, dependent
 * selects) → AI drafting/adaptation → substitution. Route-specific concerns
 * (request parsing, usage metering wiring, response shaping, audit rows, S3
 * writes) stay with the caller; only genuinely different fill semantics are
 * options here (see `requiredFields`).
 */

import { panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { clauseBodyToRichPatch } from "@/api/lib/clauses/clause-to-patch";
import type { ClauseBody } from "@/api/lib/clauses/types";
import {
  adaptAiFields,
  type AiOccurrenceAdapter,
} from "@/api/lib/docx/adapt-ai-fields";
import { discoverClauseSlots } from "@/api/lib/docx/discover-clause-slots";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import {
  documentTextForAiFields,
  extractText,
} from "@/api/lib/docx/extract-text";
import { createDispatchLookupResolver } from "@/api/lib/docx/lookup-fields";
import { manifestNamedConditions } from "@/api/lib/docx/manifest-conditions";
import { applyManifestFillSteps } from "@/api/lib/docx/manifest-fill-steps";
import { fillTemplate } from "@/api/lib/docx/patch-template";
import { buildIsRegistryEnabledForOrg } from "@/api/lib/docx/registry-org-gate";
import {
  type AiConditionDecider,
  resolveAiConditions,
} from "@/api/lib/docx/resolve-ai-conditions";
import {
  type AiFieldGenerator,
  resolveAiFields,
} from "@/api/lib/docx/resolve-ai-fields";
import { resolveClauseSlots } from "@/api/lib/docx/resolve-clause-slots";
import { readManifest } from "@/api/lib/docx/template-manifest";
import {
  boundTemplateWarnings,
  fieldOverlayWarnings,
  type TemplateWarning,
} from "@/api/lib/docx/template-warnings";
import type {
  DiscoveredField,
  DiscoveredTemplate,
  FieldDateFormat,
  FieldMeta,
  FieldPart,
  InputType,
} from "@/api/lib/docx/types";
import { isTemplateData } from "@/api/lib/docx/types";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { buildBindingContext } from "@/api/lib/template-binding/build-binding-context";
import { recordTemplateUse } from "@/api/lib/templates/record-use";

import {
  collectRawTemplateInputSources,
  collectTemplateInputKeys,
  findUnusedTemplateValueKeys,
  isFillableTemplateInputField,
} from "./template-input-contract";
import {
  applyOmittedOptionalPlaceholderDefaults,
  collectMissingRequiredFields,
  isTemplateFieldRequired,
} from "./template-optional-defaults";
import type {
  MissingRequiredField,
  RequiredFieldsPolicy,
} from "./template-optional-defaults";

export type { MissingRequiredField } from "./template-optional-defaults";

// Data a template is filled with: open-ended field-path → value map (paths come
// from the template's manifest/markers, not a fixed entity), patched in place
// with resolved clause slots and AI-drafted fields before fill.
type FillValues = Record<string, unknown>;

type UnusedValuePolicy = "allow" | "reject";
type TemplateUseRecording = "after-fill" | "caller";

type TemplateInputRejection = {
  type: "unused-values";
  keys: string[];
};

type FillRejection<TUsageRejection> =
  | { error: string }
  | { inputRejection: TemplateInputRejection }
  | { requiredFieldsRejection: MissingRequiredField[] }
  | { usageRejection: TUsageRejection };

/**
 * An already-resolved DOCX to fill: the loaded bytes plus display metadata.
 * A stored template also carries its `templateId`, which enables clause-slot
 * resolution and use recording; a built-in / in-memory template (e.g. the
 * report layout) omits it — it has no linked clauses and no row to increment.
 */
export type FillTemplateSource = {
  name: string;
  fileName: string;
  buffer: Buffer;
  templateId?: SafeId<"template"> | undefined;
  /** The template's declared document languages. The aiAdapt rewriter
   *  conjugates its per-occurrence rendering in them, so a caller that builds
   *  that collaborator passes these through. */
  documentLanguages?: readonly string[] | undefined;
};

/**
 * Resolve a stored template into a fill source: its row plus the DOCX bytes
 * from S3. Null when no such template exists for the caller, which every
 * boundary reports as not found.
 *
 * The organization predicate is redundant with RLS on `scopedDb` and stays
 * anyway: tenant isolation on a cross-tenant-addressable id should not rest on
 * a single mechanism, and a session whose RLS role is ever misconfigured must
 * still not read another organization's template.
 */
export const loadStoredTemplateSource = async ({
  templateId,
  organizationId,
  scopedDb,
}: {
  templateId: SafeId<"template">;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
}): Promise<FillTemplateSource | null> => {
  const template = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: {
        id: { eq: templateId },
        organizationId: { eq: organizationId },
      },
      columns: { name: true, fileName: true, s3Key: true, languages: true },
    }),
  );
  if (!template) {
    return null;
  }
  const buffer = Buffer.from(await readS3ArrayBuffer(template.s3Key));
  return {
    name: template.name,
    fileName: template.fileName,
    buffer,
    templateId,
    documentLanguages: template.languages,
  };
};

type DescribedField = {
  path: string;
  label: string | null;
  inputType: InputType;
  required: boolean;
  /** Short fill guidance (expected format, where to find the value). */
  hint: string | null;
  /** Allowed values for a select; null when the field is not a select. */
  options: string[] | null;
  /**
   * Lookup field output formats: the bare `{{path}}` marker renders the first
   * format; later formats are addressed by `{{path.key}}`. Null for
   * non-lookup fields so an agent knows which fields resolve from a registry.
   */
  formats: { key: string; template: string }[] | null;
  /** AI-drafting instruction (this field is written by AI at fill time when
   *  the value is omitted); null when the field is not AI-drafted. */
  aiPrompt: string | null;
  /** True when the entered value is a stub AI rewrites per occurrence to fit
   *  the surrounding text; false otherwise. */
  aiAdapt: boolean;
  /** Path of another field that supplies this select's options live at fill
   *  time (dependent select); null when the options are static/none. */
  optionsFrom: string | null;
  /** Locale-aware date rendering for a date field; null when unset. */
  dateFormat: FieldDateFormat | null;
  /** Composite parts joined by {@link DescribedField.format}; null when the
   *  field is not composite. */
  parts: FieldPart[] | null;
  /** Join template over the composite part keys; null when not composite. */
  format: string | null;
};

/**
 * A `{{#each path}}` loop discovered in the document: `path` in `values` must
 * be an array of objects, one per `itemFieldPaths` entry, not a flat dotted
 * key. Manifest fields for the loop's contents (e.g. `deliverables.name`,
 * `deliverables.due_date`) still appear in `fields` individually — this group
 * is what tells a caller those paths are array items rather than top-level
 * scalars. Absent for a bare `{{#each}}` of primitive values (already
 * addressed by its own array-typed field).
 */
type DescribedArrayGroup = {
  path: string;
  itemFieldPaths: string[];
};

/** Walk discovered fields (from {@link discoverTemplate}) for every
 *  `{{#each}}` loop over object items, regardless of whether the template
 *  also carries a manifest — manifest fields never declare the array root
 *  itself, only its dotted item paths, so this is the only source for the
 *  array shape. */
const collectDescribedArrayGroups = (
  fields: readonly DiscoveredField[],
): DescribedArrayGroup[] => {
  const groups: DescribedArrayGroup[] = [];

  const visit = (field: DiscoveredField, parentPath: string): void => {
    const path = parentPath === "" ? field.path : `${parentPath}.${field.path}`;
    const itemFields = field.itemFields;
    // A leaf field has no children to group or descend into.
    if (itemFields === undefined) {
      return;
    }
    // A loop item field path of exactly "value" is genuinely ambiguous from
    // discovered marker text alone: it is the primitive-loop convention
    // (`{{#each tags}}{{tags.value}}{{/each}}`, values.tags an array of
    // scalars) AND the marker an object-item loop produces when its one
    // declared property happens to be literally named "value"
    // (`{{#each entries}}{{entries.value}}{{/each}}`, values.entries an
    // array of `{ value }` objects) — both compile to the identical
    // itemFields shape. Suppressing this group on that heuristic hid the
    // latter, real case from `arrays` entirely; the fill engine accepts
    // either shape for a bare `.value` marker (see `buildItemContext` in
    // block-directives.ts, which merges an object row's properties into the
    // same context a primitive row's synthesized `.value` uses), so listing
    // every item-field loop here — never guessing which convention a
    // template intends — costs nothing but a redundant hint on the
    // primitive-loop case.
    if (field.kind === "array" && itemFields.length > 0) {
      groups.push({
        path,
        itemFieldPaths: itemFields.map((itemField) => itemField.path),
      });
    }
    for (const itemField of itemFields) {
      visit(itemField, path);
    }
  };

  for (const field of fields) {
    visit(field, "");
  }
  return groups;
};

export type DescribeTemplateResult =
  | {
      name: string;
      fields: DescribedField[];
      conditions: { name: string; expression: string }[];
      computed: { name: string; expression: string }[];
      arrays: DescribedArrayGroup[];
      /** Marker authoring mistakes found in the stored DOCX plus the ones its
       *  field configuration introduces. Advisory: the template is served
       *  either way. */
      warnings: TemplateWarning[];
    }
  | { error: string };

/** Marker warnings from discovery, plus the ones only the configured fields
 *  can reveal (a `condition` on a path the document also prints, a lookup
 *  whose registry the organization has not enabled). */
const describedWarnings = async ({
  discovered,
  fields,
  organizationId,
  scopedDb,
}: {
  discovered: DiscoveredTemplate;
  fields: readonly FieldMeta[];
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
}): Promise<TemplateWarning[]> =>
  boundTemplateWarnings([
    ...discovered.warnings,
    ...(await fieldOverlayWarnings({
      conditionPaths: discovered.conditionPaths,
      fields,
      placeholderPaths: discovered.placeholders.map(({ name }) => name),
      registryGate: async () =>
        await buildIsRegistryEnabledForOrg({ organizationId, scopedDb }),
    })),
  ]);

export const describeStoredTemplate = async ({
  templateId,
  organizationId,
  scopedDb,
}: {
  templateId: SafeId<"template">;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
}): Promise<DescribeTemplateResult> => {
  const loaded = await loadStoredTemplateSource({
    templateId,
    organizationId,
    scopedDb,
  });
  if (!loaded) {
    return { error: "Template not found." };
  }

  const [manifest, discovered] = await Promise.all([
    readManifest(loaded.buffer),
    discoverTemplate(loaded.buffer),
  ]);
  const arrays = collectDescribedArrayGroups(discovered.fields);
  if (manifest) {
    // Formula fields are derived at fill time, never user-submitted, so they
    // are reported as computed values rather than fillable fields. A boolean
    // condition-field is likewise derived (a rule, not a question), so it is
    // reported in `conditions`, not as a fillable field.
    return {
      name: loaded.name,
      arrays,
      warnings: await describedWarnings({
        discovered,
        fields: manifest.fields,
        organizationId,
        scopedDb,
      }),
      fields: manifest.fields
        .filter(isFillableTemplateInputField)
        .map((field) => ({
          path: field.path,
          label: field.label ?? null,
          inputType: field.inputType ?? "text",
          required: isTemplateFieldRequired(field),
          hint: field.hint ?? null,
          options: field.options ?? null,
          formats:
            field.lookup === undefined
              ? null
              : field.lookup.formats.map((format) => ({
                  key: format.key,
                  template: format.template,
                })),
          aiPrompt: field.aiPrompt ?? null,
          aiAdapt: field.aiAdapt ?? false,
          optionsFrom: field.optionsFrom ?? null,
          dateFormat: field.dateFormat ?? null,
          parts: field.parts ?? null,
          format: field.format ?? null,
        })),
      // Synthesized so each boolean condition-field (name = path) appears here
      // as a rule rather than a fillable field.
      conditions: manifestNamedConditions(manifest).map((c) => ({
        name: c.name,
        expression: c.expression,
      })),
      computed: manifest.fields.flatMap((field) =>
        field.formula === undefined
          ? []
          : [{ name: field.path, expression: field.formula }],
      ),
    };
  }

  // No manifest (a raw upload): fall back to discovered field paths.
  return {
    name: loaded.name,
    arrays,
    warnings: await describedWarnings({
      discovered,
      fields: [],
      organizationId,
      scopedDb,
    }),
    fields: discovered.fields.map((field) => ({
      path: field.path,
      label: null,
      inputType: "text",
      required: false,
      hint: null,
      options: null,
      formats: null,
      aiPrompt: null,
      aiAdapt: false,
      optionsFrom: null,
      dateFormat: null,
      parts: null,
      format: null,
    })),
    conditions: [],
    computed: [],
  };
};

/**
 * Usage preflight hook invoked once the manifest is read and the template is
 * known to declare AI fields, before any model call runs. Returns a rejection
 * marker (an over-quota / no-entitlement signal the caller maps to its HTTP
 * response) or `null` to proceed. Lets a caller gate AI quota on a model call
 * actually running without re-reading the template manifest itself.
 */
type FillUsagePreflight<TRejection> = () => Promise<TRejection | null>;

/** The model-backed collaborators a manifest's AI fields need: a generator for
 *  AI-fillable fields (`aiPrompt`), a decider for AI-decided boolean fields (a
 *  boolean field with an `aiPrompt`), and a per-occurrence adapter for
 *  `aiAdapt` fields. Each is optional; an absent one leaves its fields
 *  unresolved rather than failing the fill. */
export type AiFillCollaborators = {
  generateAiValue?: AiFieldGenerator | undefined;
  decideAiCondition?: AiConditionDecider | undefined;
  adaptAiValue?: AiOccurrenceAdapter | undefined;
};

/**
 * Builds {@link AiFillCollaborators}, invoked once and only when the manifest
 * declares an AI-drafted or AI-adapted field. Deferred because building them
 * costs the caller an org AI config read and a metered analytics trace: a
 * deterministic fill must pay neither.
 */
type AiFillCollaboratorProvider = () =>
  | AiFillCollaborators
  | Promise<AiFillCollaborators>;

type FillServiceOptions<TRejection = never> = {
  templateId: SafeId<"template">;
  values: FillValues;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  /** Whether a required, user-entered field left absent or empty rejects the
   *  fill. `"enforce"` is the contract for every real fill; `"allow-partial"`
   *  is the live preview's deliberate exception (see
   *  {@link RequiredFieldsPolicy}). Mandatory so each boundary names its
   *  stance. */
  requiredFields: RequiredFieldsPolicy;
  /** Per-fill clause edits keyed by slot patch key (`@clause:Name`). When a
   *  key matches a discovered slot, the override body is inserted for that slot
   *  instead of the linked clause's resolved body (mirrors fill-by-id). */
  clauseOverrides?: Record<string, ClauseBody> | undefined;
  /** Deferred builder for the AI collaborators; omitted by a caller that never
   *  drafts (the fill then leaves AI fields unresolved). */
  aiCollaborators?: AiFillCollaboratorProvider | undefined;
  /** Optional usage preflight run only when the manifest declares AI fields,
   *  before any model call. A non-null return aborts the fill with a
   *  `{ usageRejection }` result the caller surfaces as its own response. */
  assertUsageAvailable?: FillUsagePreflight<TRejection> | undefined;
  /** The persistence owner may defer use-count recording into its own atomic
   *  transaction. All ordinary fill callers retain the after-fill default. */
  useRecording?: TemplateUseRecording | undefined;
  /** The matter being filled into. When set and the manifest declares any
   *  data-bound field ({@link FieldMeta.source}), the matter's client, parties,
   *  attorneys, matter fields, and firm are resolved into a binding context and
   *  supply those fields' values. Absent on transient fills (no matter), which
   *  leaves bound fields unfilled. */
  workspaceId?: SafeId<"workspace"> | undefined;
};

type FilledDocx = {
  templateName: string;
  fileName: string;
  buffer: Buffer;
  unmatchedPlaceholders: string[];
  unusedValues: string[];
  structureErrors: Awaited<ReturnType<typeof fillTemplate>>["structureErrors"];
};

type FillDocxOptions<TRejection = never> = Omit<
  FillServiceOptions<TRejection>,
  "templateId"
> & {
  source: FillTemplateSource;
};

type FillDocxWithPolicyOptions<TRejection = never> =
  FillDocxOptions<TRejection> & {
    unusedValuePolicy: UnusedValuePolicy;
  };

/**
 * Shared fill recipe over an already-loaded DOCX: gate required fields,
 * resolve clause slots (stored templates only), run the manifest fill steps
 * (lookups, composites, formulas, dependent selects), draft/adapt AI fields,
 * then substitute. Records the template use when a `templateId` is present.
 * Backs every fill boundary, so a template fills identically at each of them.
 */
const fillTemplateDocxWithPolicy = async <TRejection = never>({
  source,
  values,
  scopedDb,
  organizationId,
  requiredFields,
  clauseOverrides,
  aiCollaborators,
  assertUsageAvailable,
  useRecording = "after-fill",
  workspaceId,
  unusedValuePolicy,
}: FillDocxWithPolicyOptions<TRejection>): Promise<
  FilledDocx | FillRejection<TRejection>
> => {
  const loaded = source;
  const { templateId } = source;
  const manifest = await readManifest(loaded.buffer);
  let strictInputPlaceholders: string[] | null = null;

  if (unusedValuePolicy === "reject") {
    const discovered = await discoverTemplate(loaded.buffer);
    strictInputPlaceholders = discovered.placeholders.map(
      (placeholder) => placeholder.name,
    );
    const rawInputSources = collectRawTemplateInputSources({
      fields: discovered.fields,
      placeholderPaths: discovered.placeholders.map(
        (placeholder) => placeholder.name,
      ),
    });
    const inputContract =
      manifest === null
        ? collectTemplateInputKeys({
            type: "raw",
            ...rawInputSources,
          })
        : collectTemplateInputKeys({
            type: "manifest",
            derivedOutputPaths: manifest.fields.flatMap((field) => {
              const paths = isFillableTemplateInputField(field)
                ? []
                : [field.path];
              if (field.lookup !== undefined) {
                for (const format of field.lookup.formats) {
                  paths.push(`${field.path}.${format.key}`);
                }
              }
              return paths;
            }),
            fillableFieldPaths: manifest.fields
              .filter(isFillableTemplateInputField)
              .map((field) => field.path),
            livePaths: rawInputSources.terminalPaths,
            arrayPaths: rawInputSources.arrayPaths,
            primitiveArrayPaths: rawInputSources.primitiveArrayPaths,
          });
    const unusedKeys = findUnusedTemplateValueKeys({
      contract: inputContract,
      values,
    });
    if (unusedKeys.length > 0) {
      return {
        inputRejection: { type: "unused-values", keys: unusedKeys },
      };
    }
  }

  let record: FillValues = { ...values };

  // Reject before any clause/AI/lookup work runs: a required, user-entered
  // field (not AI-fillable, not formula/condition/source-derived) that is
  // absent or empty must never be silently invented or left as a raw
  // `{{marker}}` in the output. Ask the caller for exactly these fields
  // instead of guessing. Every real fill passes "enforce" here; the live
  // fill-preview route names its exception with "allow-partial".
  if (manifest) {
    const missingRequiredFields = collectMissingRequiredFields({
      fields: manifest.fields,
      policy: requiredFields,
      values: record,
    });
    if (missingRequiredFields.length > 0) {
      return { requiredFieldsRejection: missingRequiredFields };
    }
  }

  const slots =
    templateId !== undefined ? await discoverClauseSlots(loaded.buffer) : [];
  if (templateId !== undefined && slots.length > 0) {
    const patches = await resolveClauseSlots(
      templateId,
      slots,
      scopedDb,
      organizationId,
    );
    // Per-fill overrides take precedence over the linked clause body for any
    // slot whose patch key matches a discovered slot (mirrors fill-by-id's
    // resolveClausePatches).
    if (clauseOverrides) {
      const slotKeys = new Set(slots.map((slot) => slot.patchKey));
      for (const [key, overrideBody] of Object.entries(clauseOverrides)) {
        if (slotKeys.has(key)) {
          patches[key] = clauseBodyToRichPatch(overrideBody);
        }
      }
    }
    for (const [key, value] of Object.entries(patches)) {
      record[key] = value;
    }
  }

  // Draft AI-fillable fields (manifest fields with an aiPrompt) before fill.
  let fillBuffer = loaded.buffer;
  let adaptedPaths: readonly string[] = [];
  if (manifest) {
    // Gate the AI usage preflight and the collaborator build on a model call
    // actually running: both cost the caller quota or an org AI config read,
    // and a deterministic fill must spend neither. Runs before the manifest
    // fill steps so an over-quota fill rejects without first calling out to a
    // registry for its lookup fields.
    const hasAiFields = manifest.fields.some(
      (field) => Boolean(field.aiPrompt) || field.aiAdapt === true,
    );
    if (assertUsageAvailable && hasAiFields) {
      const usageRejection = await assertUsageAvailable();
      if (usageRejection !== null) {
        return { usageRejection };
      }
    }
    const { generateAiValue, decideAiCondition, adaptAiValue } =
      aiCollaborators && hasAiFields ? await aiCollaborators() : {};

    // Resolve the data-binding context only when this fill targets a matter and
    // the manifest actually declares a bound field, so a transient fill or a
    // template with no bindings fires no extra queries.
    const bindingContext =
      workspaceId !== undefined &&
      manifest.fields.some((field) => field.source !== undefined)
        ? await buildBindingContext({
            scopedDb,
            organizationId,
            workspaceId,
            manifest,
          })
        : null;

    // Resolve registry lookups, assemble composite (multipart) values,
    // evaluate formula (derived) fields, and check dependent (optionsFrom)
    // selects before any AI step or substitution sees them; a failing step
    // rejects naming the field.
    const stepError = await applyManifestFillSteps({
      values: record,
      manifest,
      resolveLookup: createDispatchLookupResolver({
        isRegistryEnabledForOrg: await buildIsRegistryEnabledForOrg({
          organizationId,
          scopedDb,
        }),
      }),
      bindingContext,
    });
    if (stepError !== null) {
      return { error: stepError };
    }

    const documentText = await documentTextForAiFields(
      new Uint8Array(loaded.buffer),
      manifest.fields,
    );
    record = await resolveAiFields({
      values: record,
      fields: manifest.fields,
      documentText,
      generate: generateAiValue,
    });
    // Decide AI-decided boolean conditions (a boolean field with an aiPrompt)
    // before substitution so its {{#if field_path}} block resolves correctly.
    record = await resolveAiConditions({
      values: record,
      fields: manifest.fields,
      decide: decideAiCondition,
    });
    // Rewrite each aiAdapt marker occurrence to fit its surrounding text;
    // the stub stays in `record` so uncovered occurrences still get the
    // plain global substitution below.
    const adapted = await adaptAiFields({
      buffer: loaded.buffer,
      fields: manifest.fields,
      values: record,
      adapt: adaptAiValue,
    });
    fillBuffer = adapted.buffer;
    adaptedPaths = adapted.adaptedPaths;
  }

  const optionalDefaults =
    manifest === null || strictInputPlaceholders === null
      ? { defaultedPaths: [], values: record }
      : applyOmittedOptionalPlaceholderDefaults({
          fields: manifest.fields,
          placeholderPaths: strictInputPlaceholders,
          values: record,
        });
  record = optionalDefaults.values;

  if (!isTemplateData(record)) {
    return {
      error:
        "Values must be strings, numbers, booleans, arrays, or nested objects.",
    };
  }

  const result = await fillTemplate(fillBuffer, record);

  if (templateId !== undefined && useRecording === "after-fill") {
    await scopedDb(async (tx) => {
      await recordTemplateUse({ tx, templateId });
    });
  }

  return {
    templateName: loaded.name,
    fileName: loaded.fileName,
    buffer: result.buffer,
    unmatchedPlaceholders: result.unmatchedPlaceholders,
    // Adapted stubs no longer match a marker (each occurrence was already
    // substituted), so they are not "unused" in any user-meaningful sense.
    unusedValues: result.unusedValues.filter(
      (name) =>
        !adaptedPaths.includes(name) &&
        !optionalDefaults.defaultedPaths.includes(name),
    ),
    structureErrors: result.structureErrors,
  };
};

export const fillTemplateDocx = async <TRejection = never>(
  options: FillDocxOptions<TRejection>,
): Promise<
  | FilledDocx
  | { error: string }
  | { requiredFieldsRejection: MissingRequiredField[] }
  | { usageRejection: TRejection }
> => {
  const filled = await fillTemplateDocxWithPolicy({
    ...options,
    unusedValuePolicy: "allow",
  });
  if ("inputRejection" in filled) {
    panic("allow-policy template fill returned an input rejection");
  }
  return filled;
};

export const fillTemplateDocxStrict = async <TRejection = never>(
  options: FillDocxOptions<TRejection>,
): Promise<FilledDocx | FillRejection<TRejection>> =>
  await fillTemplateDocxWithPolicy({
    ...options,
    unusedValuePolicy: "reject",
  });

/**
 * Load a stored template's DOCX from S3 and fill it via {@link fillTemplateDocx}.
 * Backs the fill-by-id and fill-to-workspace routes, the chat tools, and the
 * report exporter.
 */
export const fillStoredTemplateDocx = async <TRejection = never>({
  templateId,
  ...options
}: FillServiceOptions<TRejection>): Promise<
  | FilledDocx
  | { error: string }
  | { requiredFieldsRejection: MissingRequiredField[] }
  | { usageRejection: TRejection }
> => {
  const loaded = await loadStoredTemplateSource({
    templateId,
    organizationId: options.organizationId,
    scopedDb: options.scopedDb,
  });
  if (!loaded) {
    return { error: "Template not found." };
  }

  return await fillTemplateDocx({ ...options, source: loaded });
};

export type FillTemplateResult =
  | { text: string; unmatchedPlaceholders: string[]; unusedValues: string[] }
  | { error: string }
  | { requiredFieldsRejection: MissingRequiredField[] };

/**
 * Fill result that carries both the rendered DOCX bytes and the assembled
 * plain text. Backs the MCP `fill_template` tool, which returns the text for
 * the agent to read plus the bytes (base64) for the agent to save.
 */
export type FillTemplateWithDocxResult =
  | {
      templateName: string;
      fileName: string;
      buffer: Buffer;
      text: string;
      unmatchedPlaceholders: string[];
      unusedValues: string[];
      structureErrors: FilledDocx["structureErrors"];
    }
  | { error: string };

type FilledTemplateWithText = Exclude<
  FillTemplateWithDocxResult,
  { error: string }
>;

const withExtractedText = async (
  filled: FilledDocx,
): Promise<FilledTemplateWithText> => {
  const { paragraphs } = await extractText(filled.buffer);
  return {
    templateName: filled.templateName,
    fileName: filled.fileName,
    buffer: filled.buffer,
    text: paragraphs
      .map((paragraph) => paragraph.text)
      .join("\n")
      .trim(),
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    unusedValues: filled.unusedValues,
    structureErrors: filled.structureErrors,
  };
};

export const fillStoredTemplateWithText = async <TRejection = never>(
  options: FillServiceOptions<TRejection>,
): Promise<
  | FillTemplateWithDocxResult
  | { requiredFieldsRejection: MissingRequiredField[] }
  | { usageRejection: TRejection }
> => {
  const filled = await fillStoredTemplateDocx(options);
  if ("usageRejection" in filled || "requiredFieldsRejection" in filled) {
    return filled;
  }
  if ("error" in filled) {
    return filled;
  }

  return await withExtractedText(filled);
};

export const fillStoredTemplateWithTextStrict = async <TRejection = never>({
  templateId,
  ...options
}: FillServiceOptions<TRejection>): Promise<
  | FillTemplateWithDocxResult
  | { inputRejection: TemplateInputRejection }
  | { requiredFieldsRejection: MissingRequiredField[] }
  | { usageRejection: TRejection }
> => {
  const loaded = await loadStoredTemplateSource({
    templateId,
    organizationId: options.organizationId,
    scopedDb: options.scopedDb,
  });
  if (!loaded) {
    return { error: "Template not found." };
  }
  const filled = await fillTemplateDocxStrict({
    ...options,
    source: loaded,
  });
  if (
    "usageRejection" in filled ||
    "inputRejection" in filled ||
    "requiredFieldsRejection" in filled
  ) {
    return filled;
  }
  if ("error" in filled) {
    return filled;
  }

  return await withExtractedText(filled);
};

export const fillStoredTemplate = async (
  options: FillServiceOptions,
): Promise<FillTemplateResult> => {
  const filled = await fillStoredTemplateDocx(options);
  if ("usageRejection" in filled) {
    // Unreachable: this caller does not pass `assertUsageAvailable`, so the
    // service never returns a usage rejection (TRejection is `never`).
    panic("fillStoredTemplate received an unexpected usage rejection");
  }
  if ("requiredFieldsRejection" in filled) {
    return filled;
  }
  if ("error" in filled) {
    return filled;
  }

  const { paragraphs } = await extractText(filled.buffer);

  return {
    text: paragraphs
      .map((paragraph) => paragraph.text)
      .join("\n")
      .trim(),
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    unusedValues: filled.unusedValues,
  };
};
