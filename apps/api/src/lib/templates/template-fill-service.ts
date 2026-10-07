import { panic, Result } from "better-result";

import { compareCodeUnit } from "@stll/collation";
/**
 * The single template fill pipeline. Every fill boundary — the REST routes
 * (raw upload, by-id download, live preview, fill-to-workspace), the chat and
 * MCP tools, and the report exporter — resolves its source through here and
 * runs exactly one sequence: required-fields gate → AI usage
 * preflight → manifest fill steps (lookups, composites, formulas, dependent
 * selects) → AI drafting/adaptation → clause slots → substitution.
 * Route-specific concerns (request parsing, usage metering wiring, response shaping, audit rows, S3
 * writes) stay with the caller; only genuinely different fill semantics are
 * options here (see `requiredFields`).
 */
import { replaceOutputMarkers } from "@stll/template-conditions";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { ScopedDb } from "@/api/db/safe-db";
import { arrayOrEmpty } from "@/api/lib/array";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getOrganizationRegistryAvailability,
  getOrganizationRegistryDispatch,
} from "@/api/lib/business-registries/credentials";
import {
  validateClauseBodyDirectives,
  inspectLegacyClauseDirectives,
  unrenderedOverrideWarning,
} from "@/api/lib/clauses/clause-directives";
import type { ClauseDirectiveWarning } from "@/api/lib/clauses/clause-directives";
import {
  discoverTemplateWithClauses,
  clauseBodyToRichPatch,
  renderedClauseFieldMarkers,
} from "@/api/lib/clauses/clause-to-patch";
import type { ClauseBody } from "@/api/lib/clauses/types";
import {
  adaptAiFields,
  type AiOccurrenceAdapter,
} from "@/api/lib/docx/adapt-ai-fields";
import { loopContext } from "@/api/lib/docx/block-directives";
import { deriveManifest } from "@/api/lib/docx/derived-manifest";
import { discoverClauseSlots } from "@/api/lib/docx/discover-clause-slots";
import {
  documentTextForAiFields,
  extractDocxDocument,
} from "@/api/lib/docx/extract-text";
import {
  createDispatchLookupResolver,
  type LookupOutcome,
  type LookupResolver,
} from "@/api/lib/docx/lookup-fields";
import { manifestNamedConditions } from "@/api/lib/docx/manifest-conditions";
import { applyManifestFillSteps } from "@/api/lib/docx/manifest-fill-steps";
import {
  fillTemplate,
  renderedTemplateMarkers,
  renderedClauseSlotOccurrences,
} from "@/api/lib/docx/patch-template";
import type { ClauseSlotVisitor } from "@/api/lib/docx/patch-template";
import {
  type AiConditionDecider,
  isAiConditionField,
  type ResolvedAiCondition,
  resolveAiConditions,
} from "@/api/lib/docx/resolve-ai-conditions";
import {
  type AiFieldError,
  type AiFieldGenerator,
  resolveAiFields,
} from "@/api/lib/docx/resolve-ai-fields";
import { resolveClauseSlotSources } from "@/api/lib/docx/resolve-clause-slots";
import {
  boundTemplateWarnings,
  fieldOverlayWarnings,
  type TemplateWarning,
} from "@/api/lib/docx/template-warnings";
import type {
  ClauseProvenance,
  DiscoveredField,
  DiscoveredTemplate,
  FieldDateFormat,
  FieldMeta,
  FieldSource,
  FieldValidation,
  InputType,
  LookupRegistry,
  TemplateManifest,
  TemplateData,
} from "@/api/lib/docx/types";
import { isTemplateData } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  cloneOperationInput,
  snapshotOperationInput,
} from "@/api/lib/proofs/checked-transaction";
import type { OperationAuthorization } from "@/api/lib/proofs/checked-transaction";
import type { BindingContext } from "@/api/lib/template-binding/apply-source-fields";
import { buildBindingContext } from "@/api/lib/template-binding/build-binding-context";
import { recordTemplateUse } from "@/api/lib/templates/record-use";
import {
  readStoredTemplateFile,
  STORED_TEMPLATE_FILE_COLUMNS,
} from "@/api/lib/templates/stored-template-file";
import { isRecord } from "@/api/lib/type-guards";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
} from "@/api/lib/usage/action-costs/context";

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
  RenderedRequiredFields,
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
  | TemplateServiceError
  | { inputRejection: TemplateInputRejection }
  | { requiredFieldsRejection: MissingRequiredField[] }
  | { usageRejection: TUsageRejection };

/**
 * An already-resolved DOCX to fill: the scanned file plus display metadata.
 * A stored template also carries its `templateId`, which enables clause-slot
 * resolution and use recording; a built-in / in-memory template (e.g. the
 * report layout) omits it — it has no linked clauses and no row to increment.
 */
export type FillTemplateSource = {
  name: string;
  fileName: string;
  file: ScannedFile;
  templateId?: SafeId<"template"> | undefined;
  /** The template's declared document languages. The aiAdapt rewriter
   *  conjugates its per-occurrence rendering in them, so a caller that builds
   *  that collaborator passes these through. */
  documentLanguages?: readonly string[] | undefined;
};

/**
 * Resolve a stored template into a fill source: its row plus its scanned DOCX
 * (see `stored-template-file.ts`). A 404 when no such template exists for the
 * caller; a 422 when its file fails the scan and a 503 when the scanner is
 * unavailable, so an unscanned file never reaches the fill.
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
}): Promise<
  Result<FillTemplateSource, HandlerError<404 | 422 | 500 | 503>>
> => {
  const template = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: {
        id: { eq: templateId },
        organizationId: { eq: organizationId },
      },
      columns: {
        ...STORED_TEMPLATE_FILE_COLUMNS,
        name: true,
        fileName: true,
        languages: true,
      },
    }),
  );
  if (!template) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }
  const file = await readStoredTemplateFile({
    safeDb: safeDbFromScoped(scopedDb),
    organizationId,
    row: template,
    fileName: template.fileName,
  });
  if (Result.isError(file)) {
    return Result.err(file.error);
  }
  return Result.ok({
    name: template.name,
    fileName: template.fileName,
    file: file.value,
    templateId,
    documentLanguages: template.languages,
  });
};

type TemplateServiceError = {
  error: string;
  /** The stored-file failure for callers that expose a structured error. */
  storedTemplateError?: HandlerError<404 | 422 | 500 | 503>;
};

/** A failed stored-template load with its status and issue details intact. */
const storedTemplateLoadError = (
  error: HandlerError<404 | 422 | 500 | 503>,
): TemplateServiceError => {
  if (error.status === 404) {
    return { error: "Template not found.", storedTemplateError: error };
  }
  return {
    error:
      error.hint === undefined
        ? error.message
        : `${error.message} ${error.hint}`,
    storedTemplateError: error,
  };
};

type DescribedField = {
  path: string;
  /** Branch expression evaluated for this document or loop item. */
  visibleWhen: string | null;
  label: string | null;
  inputType: InputType;
  required: boolean;
  /** Short fill guidance (expected format, where to find the value). */
  hint: string | null;
  /** Allowed values for a select; null when the field is not a select. */
  options: string[] | null;
  /**
   * Registry lookup: which register resolves the submitted number, and the
   * named output formats it renders — each addressed by `{{path.key}}`, the
   * first also by the bare `{{path}}`. Null for non-lookup fields. Echoed in
   * the shape the `fields` overlay accepts, so a describe payload can be
   * edited and sent straight back.
   */
  lookup: {
    registry: LookupRegistry;
    formats: { key: string; template: string }[];
  } | null;
  /** Fill-time constraints (required, lengths, bounds, pattern, item counts);
   *  null when the field declares none. */
  validation: FieldValidation | null;
  /** Matter or contact data the value is bound to and resolved from at fill
   *  time; null when the field is not bound. */
  source: FieldSource | null;
  /** True when the rendered document is included in this AI field's prompt. */
  aiSeesDocument: boolean;
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
};

/**
 * A `{% for item in path %}` loop discovered in the document: `path` in `values` must
 * be an array of objects, one per `itemFieldPaths` entry, not a flat dotted
 * key. Manifest fields for the loop's contents (e.g. `deliverables.name`,
 * `deliverables.due_date`) still appear in `fields` individually — this group
 * is what tells a caller those paths are array items rather than top-level
 * scalars. Absent for a bare `{% for %}` of primitive values (already
 * addressed by its own array-typed field).
 */
type DescribedArrayGroup = {
  path: string;
  itemAliases: string[];
  itemFieldPaths: string[];
};

/** Walk discovered fields (from {@link discoverTemplate}) for every
 *  `{% for %}` loop over object items, regardless of whether the template
 *  also carries a manifest — manifest fields never declare the array root
 *  itself, only its dotted item paths, so this is the only source for the
 *  array shape. */
const collectDescribedScopes = (fields: readonly DiscoveredField[]) => {
  const groups: DescribedArrayGroup[] = [];
  const fieldScopes = new Map<string, string | undefined>();

  const visit = (field: DiscoveredField, parentPath: string): void => {
    const path = parentPath === "" ? field.path : `${parentPath}.${field.path}`;
    fieldScopes.set(path, field.visibleWhen);
    const itemFields = field.itemFields;
    // A leaf field has no children to group or descend into.
    if (itemFields === undefined) {
      return;
    }
    // A loop item field path of exactly "value" is genuinely ambiguous from
    // discovered marker text alone: it is the primitive-loop convention
    // (`{% for tag in tags %}{{ tag.value }}{% endfor %}`, values.tags an array of
    // scalars) AND the marker an object-item loop produces when its one
    // declared property happens to be literally named "value"
    // (`{% for entry in entries %}{{ entry.value }}{% endfor %}`, values.entries an
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
        itemAliases: arrayOrEmpty(field.itemAliases),
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
  return { arrays: groups, fieldScopes };
};

/**
 * One `{% if %}` block of the document, named by the field path that governs
 * it and by how that path gets its value: the person answers it (`asked`), a
 * rule derives it (`rule`, with the expression, named the way the `fields`
 * overlay names it so a caller can edit it and send it straight back), or the
 * model decides it at fill time (`ai`, with the instructions it decides on).
 *
 * Without this an AI-decided block is invisible: its field reads as a boolean
 * with an `ai` source and nothing says it gates a paragraph.
 */
type DescribedCondition = { path: string } & (
  | { kind: "asked" }
  | { kind: "rule"; condition: string }
  | { kind: "ai"; prompt: string }
);

export type DescribeTemplateResult =
  | {
      name: string;
      fields: DescribedField[];
      /** Every gated block the document carries; see {@link DescribedCondition}. */
      conditions: DescribedCondition[];
      computed: { path: string; formula: string }[];
      arrays: DescribedArrayGroup[];
      /** Marker authoring mistakes found in the stored DOCX plus the ones its
       *  field configuration introduces. Advisory: the template is served
       *  either way. */
      warnings: TemplateWarning[];
    }
  | TemplateServiceError;

/** Marker warnings from discovery, plus the ones only the configured fields
 *  can reveal (a `condition` on a path the document also prints, a lookup
 *  whose registry is missing required configuration). */
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
      loadRegistryAvailability: async () =>
        await getOrganizationRegistryAvailability({ organizationId, scopedDb }),
    })),
  ]);

/**
 * Every gated block the document carries, from the block-directive scan
 * `discoverTemplate` already performs: `conditionPaths` is every path a
 * `{% if %}` expression reads, so an AI-decided or user-answered block appears
 * beside the rule-derived ones instead of only the latter. A rule field the
 * scan did not reach (its expression gates nothing yet) still belongs here,
 * because the configure overlay addresses it by the same name.
 */
const describedConditions = ({
  conditionPaths,
  manifest,
}: {
  conditionPaths: readonly string[];
  manifest: TemplateManifest;
}): DescribedCondition[] => {
  const rules = new Map(
    manifestNamedConditions(manifest).map(({ name, expression }) => [
      name,
      expression,
    ]),
  );
  const prompts = new Map(
    manifest.fields
      .filter(isAiConditionField)
      .map((field) => [field.path, field.aiPrompt]),
  );
  return [...new Set([...conditionPaths, ...rules.keys()])]
    .toSorted(compareCodeUnit)
    .map((path): DescribedCondition => {
      const prompt = prompts.get(path);
      if (prompt !== undefined) {
        return { path, kind: "ai", prompt };
      }
      const condition = rules.get(path);
      return condition === undefined
        ? { path, kind: "asked" }
        : { path, kind: "rule", condition };
    });
};

export const describeStoredTemplate = async ({
  templateId,
  organizationId,
  scopedDb,
}: {
  templateId: SafeId<"template">;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
}): Promise<DescribeTemplateResult> => {
  const load = await loadStoredTemplateSource({
    templateId,
    organizationId,
    scopedDb,
  });
  if (Result.isError(load)) {
    return storedTemplateLoadError(load.error);
  }
  const loaded = load.value;

  const { discovered, manifest } = await discoverTemplateSource({
    source: loaded,
    scopedDb,
    organizationId,
  });
  const { arrays, fieldScopes } = collectDescribedScopes(discovered.fields);
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
        visibleWhen: fieldScopes.get(field.path) ?? null,
        label: field.label ?? null,
        inputType: field.inputType ?? "text",
        required: isTemplateFieldRequired(field),
        hint: field.hint ?? null,
        options: field.options ?? null,
        lookup:
          field.lookup === undefined
            ? null
            : {
                registry: field.lookup.registry,
                formats: field.lookup.formats.map((format) => ({
                  key: format.key,
                  template: format.template,
                })),
              },
        validation: field.validation ?? null,
        source: field.source ?? null,
        aiSeesDocument: field.aiSeesDocument ?? false,
        aiPrompt: field.aiPrompt ?? null,
        aiAdapt: field.aiAdapt ?? false,
        optionsFrom: field.optionsFrom ?? null,
        dateFormat: field.dateFormat ?? null,
      })),
    conditions: describedConditions({
      conditionPaths: discovered.conditionPaths,
      manifest,
    }),
    computed: manifest.fields.flatMap((field) =>
      field.formula === undefined
        ? []
        : [{ path: field.path, formula: field.formula }],
    ),
  };
};

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
type AiFillCollaboratorBuilder = () =>
  | AiFillCollaborators
  | Promise<AiFillCollaborators>;

export type AiFillAuthorization = OperationAuthorization<
  "ConditionalUsageAllowed",
  {
    buildCollaborators: AiFillCollaboratorBuilder;
  }
>;

export type AiFillCollaboratorProvider<TRejection> = () => Promise<
  Result<AiFillAuthorization, TRejection>
>;

type FillServiceOptions<TRejection = never> = {
  templateId: SafeId<"template">;
  values: FillValues;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  /** Lookup fields ask a business register, a third-party service. Without a
   *  permit, a lookup field fails the fill naming the field. Mandatory so each
   *  boundary names its stance. */
  thirdPartyOutboundPermit: ThirdPartyOutboundPermit | undefined;
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
  aiCollaborators?: AiFillCollaboratorProvider<TRejection> | undefined;
  /** Registry transport seam; ordinary callers use the organization's dispatch. */
  lookupResolver?: LookupResolver | undefined;
  /** A caller that records the fill itself (document persistence, or an agent
   *  tool returning the text) defers use-count recording into its own atomic
   *  transaction. Other fill callers retain the after-fill default. */
  useRecording?: TemplateUseRecording | undefined;
  /** The matter being filled into. When set and the manifest declares any
   *  data-bound field ({@link FieldMeta.source}), the matter's client, parties,
   *  attorneys, matter fields, and firm are resolved into a binding context and
   *  supply those fields' values. Absent on transient fills (no matter), which
   *  leaves bound fields unfilled. */
  workspaceId?: SafeId<"workspace"> | undefined;
};

type DiscoverTemplateSourceOptions = {
  source: FillTemplateSource;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseOverrides?: Record<string, ClauseBody> | undefined;
};

/** Discover exactly the content a fill consumes, including versioned links
 * and per-fill edits. Description, strict input validation and condition
 * preview share this owner rather than treating slots as opaque values. */
export const discoverTemplateSource = async ({
  source,
  scopedDb,
  organizationId,
  clauseOverrides,
}: DiscoverTemplateSourceOptions) => {
  const slots =
    source.templateId === undefined
      ? []
      : await discoverClauseSlots(source.file);
  const bodyByKey = new Map<string, ClauseBody>();
  const clauseByKey = new Map<string, ClauseProvenance>();
  if (source.templateId !== undefined && slots.length > 0) {
    const resolved = await resolveClauseSlotSources(
      source.templateId,
      slots,
      scopedDb,
      organizationId,
    );
    for (const [key, entry] of resolved) {
      bodyByKey.set(key, entry.body);
      clauseByKey.set(key, entry.clause);
    }
  }
  for (const slot of slots) {
    const override = clauseOverrides?.[slot.patchKey];
    if (override !== undefined) {
      bodyByKey.set(slot.patchKey, override);
      clauseByKey.set(slot.patchKey, {
        slotKey: slot.patchKey,
        resolution: "override",
      });
    }
  }
  const bodies = Object.fromEntries(bodyByKey);
  const clauses = Object.fromEntries(clauseByKey);
  const discovered = await discoverTemplateWithClauses({
    file: source.file,
    bodies,
    clauses,
  });
  return {
    slots,
    bodies,
    clauses,
    discovered,
    manifest: deriveManifest(discovered),
  };
};

/** The members of a {@link FilledDocx} that are the document itself. Every
 *  other member is a diagnostic: the completion decision reads them all
 *  (`FillDiagnosticSources` is the rest of this type), so a new member must
 *  either be listed here or be graded there. */
export type FilledDocumentMember = "templateName" | "fileName" | "file";

export type FilledDocx = {
  templateName: string;
  fileName: string;
  /** The filled document, derived from the scanned template. */
  file: ScannedFile;
  unmatchedPlaceholders: string[];
  unusedValues: string[];
  structureErrors: Awaited<ReturnType<typeof fillTemplate>>["structureErrors"];
  /** AI-drafted fields the model could not complete. A truncated or failed
   *  draft is never written, so these fields left the fill unfilled and every
   *  boundary reports them instead of presenting the document as complete. */
  aiFieldErrors: AiFieldError[];
  /** One entry per AI-decided boolean condition the fill settled, naming who
   *  settled it. A `{% if %}` block's inclusion is otherwise only visible in
   *  the rendered text, which a caller cannot tell from a block the template
   *  never carried. */
  conditionDecisions: ResolvedAiCondition[];
  clauseWarnings: ClauseDirectiveWarning[];
};

/** A fill without a permit cannot ask a register for a lookup field. */
const LOOKUP_WITHOUT_PERMIT: LookupOutcome = {
  type: "error",
  message: "Registry lookups are not available for this fill",
};

const lookupsWithoutPermit: LookupResolver = async () =>
  await Promise.resolve(LOOKUP_WITHOUT_PERMIT);

type FillLookupResolverOptions = {
  permit: ThirdPartyOutboundPermit | undefined;
  lookupResolver: LookupResolver | undefined;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
};

/** Without a permit no resolver reaches a register, injected or dispatched. */
const fillLookupResolver = async ({
  permit,
  lookupResolver,
  scopedDb,
  organizationId,
}: FillLookupResolverOptions) => {
  if (permit === undefined) {
    return lookupsWithoutPermit;
  }
  return (
    lookupResolver ??
    createDispatchLookupResolver({
      observer: actionRequestObserver(
        organizationId,
        ACTION_COST_CALL_KIND.registryRequest,
      ),
      permit,
      dispatch: await getOrganizationRegistryDispatch({
        scopedDb,
        organizationId,
      }),
    })
  );
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

type ApplyClausePatchesOptions = Pick<
  Awaited<ReturnType<typeof discoverTemplateSource>>,
  "bodies" | "clauses" | "slots"
> & {
  record: TemplateData;
  namedConditions: ReturnType<typeof manifestNamedConditions>;
  /** The slots the fill keeps a marker of; the others are never rendered. */
  renderedSlots: ReadonlySet<string>;
};

export const clauseDirectiveRecoveryHint = (
  clause: ClauseProvenance,
): string => {
  const readSave =
    "Use list_clauses with clause_id to read the clause, then save_clause with snapshot_version=true to publish corrected paragraphs.";
  switch (clause.resolution) {
    case "override":
      return "Correct the clause override in this fill before filling again.";
    case "pinned":
      return `${readSave} Sync the pinned template clause link before filling again.`;
    case "explicit":
      return `${readSave} Update the template's :vN clause marker to the corrected published version before filling again.`;
    case "variant":
      return "Correct the linked clause variant, then fill again. Use list_clauses with clause_id to read the owning clause.";
    case "latest":
    case undefined:
      return `${readSave} The slot reads the latest saved version; autosaving the working copy alone does not publish it.`;
    default:
      return panic("Unhandled clause resolution");
  }
};

type ClauseDirectiveErrorOptions = {
  error: HandlerError<422>;
  clause: ClauseProvenance;
  slot: ApplyClausePatchesOptions["slots"][number];
};

const clauseDirectiveError = ({
  error,
  clause,
  slot,
}: ClauseDirectiveErrorOptions) => {
  const identity = `${clause.name ?? slot.name}${clause.id === undefined ? "" : ` (${clause.id})`}`;
  return new HandlerError({
    status: 422,
    code: error.code,
    retryable: false,
    clause,
    message: `Clause ${identity} in slot ${slot.patchKey} has invalid directives: ${error.message}`,
    hint: clauseDirectiveRecoveryHint(clause),
    issues: error.issues,
  });
};

/** A per-fill override whose directives do not validate, with the refusal it
 *  earns wherever its slot renders. */
type InvalidOverride = {
  slot: ApplyClausePatchesOptions["slots"][number];
  error: HandlerError<422>;
};

const invalidAuthoredClauseOverrides = ({
  slots,
  bodies,
  clauses,
}: Pick<
  ApplyClausePatchesOptions,
  "slots" | "bodies" | "clauses"
>): InvalidOverride[] =>
  slots.flatMap((slot) => {
    const clause = clauses[slot.patchKey];
    if (clause?.resolution !== "override") {
      return [];
    }
    const body =
      bodies[slot.patchKey] ??
      panic(`Missing override body for ${slot.patchKey}`);
    const validation = validateClauseBodyDirectives(body);
    return Result.isError(validation)
      ? [
          {
            slot,
            error: clauseDirectiveError({
              error: validation.error,
              clause,
              slot,
            }),
          },
        ]
      : [];
  });

/**
 * An invalid override refuses the fill where its slot renders. One whose slot
 * the fill prunes never reaches the document, so it is reported as a warning.
 */
const settleInvalidOverrides = (
  invalid: readonly InvalidOverride[],
  renderedSlots: ReadonlySet<string>,
): Result<ClauseDirectiveWarning[], HandlerError<422>> => {
  const refused = invalid.find(({ slot }) => renderedSlots.has(slot.patchKey));
  if (refused !== undefined) {
    return Result.err(refused.error);
  }
  return Result.ok(
    invalid.map(({ slot, error }) =>
      unrenderedOverrideWarning({
        clauseName: slot.name,
        slotKey: slot.patchKey,
        issues: arrayOrEmpty(error.issues),
      }),
    ),
  );
};

type RenderClauseSlotOptions = {
  slot: ApplyClausePatchesOptions["slots"][number];
  body: ClauseBody;
  clause: ClauseProvenance;
  values: TemplateData;
  namedConditions: ApplyClausePatchesOptions["namedConditions"];
  enclosingLoop?: ReturnType<typeof loopContext> | undefined;
};

/** One clause slot rendered against the values in scope where it renders. */
const renderClauseSlot = ({
  slot,
  body,
  clause,
  values,
  namedConditions,
  enclosingLoop,
}: RenderClauseSlotOptions) => {
  const patch = clauseBodyToRichPatch(body, {
    source: clause.resolution === "override" ? "authored" : "stored",
    values,
    slotKey: slot.patchKey,
    namedConditions,
    enclosingLoop,
  });
  return Result.isError(patch)
    ? Result.err(clauseDirectiveError({ error: patch.error, clause, slot }))
    : patch;
};

/** What a fill renders for one set of values. */
type RenderedFill = {
  /** Clause slots with at least one marker the fill keeps. */
  slots: ReadonlySet<string>;
  required: RenderedRequiredFields;
};

type RenderedFillOptions = {
  file: ScannedFile;
  discovered: DiscoveredTemplate;
  values: TemplateData;
  bodies: ApplyClausePatchesOptions["bodies"];
  namedConditions: ApplyClausePatchesOptions["namedConditions"];
  occurrenceValues?: readonly PreparedClauseOccurrence[];
};

/**
 * Every clause slot and value marker the fill renders for `values`, read from
 * the directive pass the fill renders with: the template's own markers, and
 * each clause body's where its slot renders it (once per loop iteration,
 * under that iteration's bindings).
 */
const renderedFill = async ({
  file,
  discovered,
  values,
  bodies,
  namedConditions,
  occurrenceValues,
}: RenderedFillOptions): Promise<Result<RenderedFill, HandlerError<422>>> => {
  const rendered = await renderedTemplateMarkers(file, values, namedConditions);
  if (Result.isError(rendered)) {
    return rendered;
  }
  const occurrences = rendered.value.fields.map(({ path, expr, scope }) => ({
    path,
    expr,
    values: scope ?? values,
  }));
  for (const [
    index,
    { patchKey, loopScope },
  ] of rendered.value.clauseSlots.entries()) {
    const body = bodies[patchKey];
    if (body === undefined) {
      continue;
    }
    const slotValues =
      occurrenceValues?.at(index)?.values ?? loopScope ?? values;
    if (!isTemplateData(slotValues)) {
      return panic("Loop scope holds values outside the template data model");
    }
    const clauseFields = renderedClauseFieldMarkers(body, {
      values: slotValues,
      namedConditions,
      slotScope: discovered.clauseSlotScopes?.[patchKey],
    });
    if (Result.isError(clauseFields)) {
      return clauseFields;
    }
    for (const { path, expr, scope } of clauseFields.value) {
      occurrences.push({ path, expr, values: scope ?? slotValues });
    }
  }
  return Result.ok({
    slots: new Set(rendered.value.clauseSlots.map(({ patchKey }) => patchKey)),
    required: {
      paths: new Set(discovered.renderedFieldPaths?.scoped),
      occurrences,
    },
  });
};

const overlapsPath = (left: string, right: string) =>
  left === right ||
  left.startsWith(`${right}.`) ||
  right.startsWith(`${left}.`);

/**
 * Whether the submitted values already decide what the fill renders: no
 * condition or loop the template evaluates reads a value a later fill step
 * derives or rewrites (formula, binding, lookup, AI draft or decision, date
 * normalization).
 */
const renderingSettledBeforeFillSteps = (
  manifest: TemplateManifest,
  discovered: DiscoveredTemplate,
): boolean => {
  const derived = manifest.fields
    .filter(
      (field) =>
        field.formula !== undefined ||
        field.condition !== undefined ||
        field.conditionAst !== undefined ||
        field.source !== undefined ||
        field.lookup !== undefined ||
        Boolean(field.aiPrompt) ||
        (field.inputType === "date" && field.dateFormat !== undefined),
    )
    .map((field) => field.path);
  const evaluated = [
    ...discovered.conditionPaths,
    ...discovered.fields
      .filter((field) => field.kind === "array")
      .map((field) => field.path),
  ];
  return !evaluated.some((path) =>
    derived.some((derivedPath) => overlapsPath(path, derivedPath)),
  );
};

type RequiredFieldsGateOptions = {
  manifest: TemplateManifest;
  discovered: DiscoveredTemplate;
  requiredFields: RequiredFieldsPolicy;
};

/**
 * A required field is required where the fill renders it. With what renders
 * read from the submitted values (`early` given a rendering), every field is
 * gated before any AI or lookup work. Without one (later fill steps decide
 * what renders), `early` gates the fields that render whatever the values and
 * the ones no rendering places, and `late` gates the rest once every fill
 * step ran.
 */
const requiredFieldsGate = ({
  manifest,
  discovered,
  requiredFields,
}: RequiredFieldsGateOptions) => {
  const unconditional = new Set(discovered.renderedFieldPaths?.unconditional);
  const deferred = new Set(
    discovered.renderedFieldPaths?.scoped.filter(
      (path) => !unconditional.has(path),
    ),
  );
  return {
    /** Whether a gate needs to know what renders at all. */
    readsRendering:
      requiredFields === "enforce" &&
      (discovered.renderedFieldPaths?.scoped.length ?? 0) > 0,
    early: (
      values: FillValues,
      rendered: RenderedFill | null,
    ): MissingRequiredField[] =>
      collectMissingRequiredFields({
        fields: manifest.fields,
        policy: requiredFields,
        values,
        rendered: rendered?.required ?? { paths: deferred, occurrences: [] },
      }),
    late: (values: TemplateData, rendered: RenderedFill) =>
      collectMissingRequiredFields({
        fields: manifest.fields.filter((field) => deferred.has(field.path)),
        policy: requiredFields,
        values,
        rendered: rendered.required,
      }),
  };
};

const clauseScopedPaths = (discovered: DiscoveredTemplate) =>
  new Set(Object.values(discovered.clauseScopedFieldPaths ?? {}).flat());

type PreparedClauseOccurrence = {
  patchKey: string;
  values: TemplateData;
  scope: "document" | "loop";
};

/** Linked clauses are discovered independently: their own loops use array
 * paths, while references to a template loop retain its authored alias. */
const isClauseLoopField = (path: string, discovered: DiscoveredTemplate) =>
  discovered.loopAliases.some(
    ({ alias, path: arrayPath }) =>
      path.startsWith(`${alias}.`) || path.startsWith(`${arrayPath}.`),
  );

type DraftDocumentValuesOptions = DocumentGroundingOptions & {
  discovered: DiscoveredTemplate;
  resolveLookup: LookupResolver;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | undefined;
  generateAiValue: AiFieldGenerator | undefined;
  decideAiCondition: AiConditionDecider | undefined;
};

const draftDocumentValues = async ({
  file,
  manifest,
  bodies,
  record,
  discovered,
  resolveLookup,
  scopedDb,
  organizationId,
  workspaceId,
  generateAiValue,
  decideAiCondition,
}: DraftDocumentValuesOptions) => {
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

  const scopedPaths = clauseScopedPaths(discovered);
  const fields = manifest.fields.filter(
    ({ path }) =>
      !scopedPaths.has(path) || !isClauseLoopField(path, discovered),
  );
  // Resolve registry lookups, evaluate formula (derived) fields, and check
  // dependent (optionsFrom) selects before any AI step or substitution sees
  // them; a failing step rejects naming the field.
  const stepError = await applyManifestFillSteps({
    values: record,
    manifest: { fields },
    resolveLookup,
    bindingContext,
  });
  if (stepError !== null) {
    return { type: "fields-refused" as const, error: stepError };
  }

  const grounding = await documentGrounding({ file, manifest, bodies, record });
  if (Result.isError(grounding)) {
    return { type: "refused" as const, error: grounding.error };
  }
  const drafted = await resolveAiFields({
    values: record,
    fields,
    documentText: grounding.value,
    generate: generateAiValue,
  });
  const decided = await resolveAiConditions({
    values: drafted.values,
    fields,
    decide: decideAiCondition,
  });
  return {
    type: "prepared" as const,
    values: decided.values,
    grounding: grounding.value,
    bindingContext,
    aiFieldErrors: drafted.errors,
    conditionDecisions: decided.conditions,
  };
};

type PrepareClauseOccurrencesOptions = {
  file: ScannedFile;
  record: TemplateData;
  discovered: DiscoveredTemplate;
  manifest: TemplateManifest;
  namedConditions: ApplyClausePatchesOptions["namedConditions"];
  resolveLookup: LookupResolver;
  bindingContext: BindingContext | null;
  generateAiValue: AiFieldGenerator | undefined;
  decideAiCondition: AiConditionDecider | undefined;
  documentText: string | undefined;
};

/** Prepare each surviving occurrence with the same value pipeline as the
 * document, keeping item derivations local to that occurrence. */
const prepareClauseOccurrences = async ({
  file,
  record,
  discovered,
  manifest,
  namedConditions,
  resolveLookup,
  bindingContext,
  generateAiValue,
  decideAiCondition,
  documentText,
}: PrepareClauseOccurrencesOptions) => {
  const occurrences = await renderedClauseSlotOccurrences(
    file,
    record,
    namedConditions,
  );
  if (Result.isError(occurrences)) {
    return {
      type: "refused" as const,
      rejection: {
        error: occurrences.error.message,
        storedTemplateError: occurrences.error,
      },
    };
  }
  const aiFieldErrors: AiFieldError[] = [];
  const conditionDecisions: ResolvedAiCondition[] = [];
  const occurrenceValues: PreparedClauseOccurrence[] = [];
  const preparedDocumentPaths = new Set<string>();
  for (const { patchKey, loopScope } of occurrences.value) {
    const paths = new Set(
      arrayOrEmpty(discovered.clauseScopedFieldPaths?.[patchKey]),
    );
    const fields = manifest.fields.filter(
      (field) =>
        paths.has(field.path) &&
        isClauseLoopField(field.path, discovered) &&
        (loopScope !== undefined || !preparedDocumentPaths.has(field.path)),
    );
    if (loopScope !== undefined) {
      for (const [index, field] of fields.entries()) {
        const scope = discovered.clauseSlotScopes?.[
          patchKey
        ]?.rowScopes.findLast(({ scopedPath }) =>
          field.path.startsWith(`${scopedPath}.`),
        );
        if (scope !== undefined) {
          // The manifest uses array paths; this occurrence prepares one alias-bound item.
          fields[index] = {
            ...field,
            path: `${scope.alias}${field.path.slice(scope.scopedPath.length)}`,
          };
        }
      }
    }
    // Fill steps mutate declared values; copy only those roots rather than
    // cloning every document-level array once for every item.
    const roots = new Set(
      fields.map(
        ({ path }) => path.split(".").at(0) ?? panic("Field path has no root"),
      ),
    );
    const values =
      loopScope === undefined
        ? record
        : {
            ...loopScope,
            ...Object.fromEntries(
              [...roots]
                .filter((root) => Object.hasOwn(loopScope, root))
                .map((root) => [root, structuredClone(loopScope[root])]),
            ),
          };
    const scopeError = await applyManifestFillSteps({
      values,
      manifest: { fields },
      resolveLookup,
      bindingContext,
    });
    if (scopeError !== null) {
      return { type: "refused" as const, rejection: { error: scopeError } };
    }
    const scopedDrafted = await resolveAiFields({
      values,
      fields,
      documentText,
      generate: generateAiValue,
    });
    aiFieldErrors.push(...scopedDrafted.errors);
    const scopedDecided = await resolveAiConditions({
      values: scopedDrafted.values,
      fields,
      decide: decideAiCondition,
    });
    conditionDecisions.push(...scopedDecided.conditions);
    if (!isTemplateData(scopedDecided.values)) {
      return panic(
        "Prepared clause scope holds values outside the template data model",
      );
    }
    if (loopScope === undefined) {
      // Preserve the shared occurrence record with own-property copies.
      Object.defineProperties(
        record,
        Object.getOwnPropertyDescriptors(scopedDecided.values),
      );
      for (const { path } of fields) {
        preparedDocumentPaths.add(path);
      }
      occurrenceValues.push({ patchKey, values: record, scope: "document" });
      continue;
    }
    occurrenceValues.push({
      patchKey,
      values: scopedDecided.values,
      scope: "loop",
    });
  }
  return {
    type: "prepared" as const,
    occurrenceValues,
    aiFieldErrors,
    conditionDecisions,
  };
};

/**
 * Renders a slot inside a loop once per iteration under that iteration's
 * bindings, exactly as the loop's own markers render. The first refusal is
 * kept for the caller, which fails the fill with it.
 */
const loopClauseSlotRenderer = ({
  slots,
  bodies,
  clauses,
  namedConditions,
  occurrenceValues,
}: Omit<ApplyClausePatchesOptions, "record"> & {
  occurrenceValues: PreparedClauseOccurrence[];
}) => {
  let occurrenceIndex = 0;
  let renderedLoopOccurrences = 0;
  let refusal: HandlerError<422> | undefined;
  const render: ClauseSlotVisitor = ({ patchKey, loopScope }) => {
    const occurrence =
      occurrenceValues.at(occurrenceIndex) ??
      panic("Clause occurrence has no prepared scope");
    if (occurrence.patchKey !== patchKey) {
      return panic("Clause occurrence order differs from its prepared scopes");
    }
    const { values } = occurrence;
    occurrenceIndex += 1;
    if (loopScope !== undefined) {
      renderedLoopOccurrences += 1;
    }
    const body = bodies[patchKey];
    const slot = slots.find((candidate) => candidate.patchKey === patchKey);
    if (
      loopScope === undefined ||
      body === undefined ||
      slot === undefined ||
      refusal !== undefined
    ) {
      return undefined;
    }
    const loop = loopScope["loop"];
    if (
      !isRecord(loop) ||
      typeof loop["index0"] !== "number" ||
      typeof loop["length"] !== "number"
    ) {
      return panic("Clause loop scope has no iteration counters");
    }
    const patch = renderClauseSlot({
      slot,
      body,
      clause:
        clauses[patchKey] ?? panic(`Missing clause provenance for ${patchKey}`),
      values,
      namedConditions,
      enclosingLoop: loopContext(loop["index0"], loop["length"]),
    });
    if (Result.isError(patch)) {
      refusal = patch.error;
      return undefined;
    }
    return patch.value;
  };
  return {
    render,
    error: () => {
      if (
        renderedLoopOccurrences !==
        occurrenceValues.filter(({ scope }) => scope === "loop").length
      ) {
        return panic(
          "Clause rendering did not visit every prepared occurrence",
        );
      }
      return refusal;
    },
  };
};

/**
 * Patch every clause slot at document scope, then fill the template, letting
 * the directive pass render each slot it keeps inside a loop per iteration.
 */
const fillWithClauseSlots = async ({
  file,
  occurrenceValues,
  ...options
}: ApplyClausePatchesOptions & {
  file: ScannedFile;
  occurrenceValues: PreparedClauseOccurrence[];
}): Promise<
  Result<
    {
      result: Awaited<ReturnType<typeof fillTemplate>>;
      clauseWarnings: ClauseDirectiveWarning[];
    },
    HandlerError<422>
  >
> => {
  const clauseWarnings = applyClausePatches(options);
  if (Result.isError(clauseWarnings)) {
    return clauseWarnings;
  }
  const loopClauses = loopClauseSlotRenderer({ ...options, occurrenceValues });
  const result = await fillTemplate(file, options.record, {
    namedConditions: options.namedConditions,
    clauseSlots: loopClauses.render,
  });
  const refusal = loopClauses.error();
  return refusal === undefined
    ? Result.ok({ result, clauseWarnings: clauseWarnings.value })
    : Result.err(refusal);
};

const applyClausePatches = ({
  slots,
  bodies,
  clauses,
  record,
  namedConditions,
  renderedSlots,
}: ApplyClausePatchesOptions): Result<
  ClauseDirectiveWarning[],
  HandlerError<422>
> => {
  const clauseWarnings: ClauseDirectiveWarning[] = [];
  for (const slot of slots) {
    const body = bodies[slot.patchKey];
    // A slot the fill prunes never reaches the document: nothing to render
    // and nothing about its clause to report.
    if (body === undefined || !renderedSlots.has(slot.patchKey)) {
      continue;
    }
    const clause =
      clauses[slot.patchKey] ??
      panic(`Missing clause provenance for ${slot.patchKey}`);
    const hint = clauseDirectiveRecoveryHint(clause);
    if (clause.resolution !== "override") {
      const warning = inspectLegacyClauseDirectives(body, {
        clauseName: clause.name ?? slot.name,
        clauseId: clause.id,
        version: clause.version ?? null,
        slotKey: slot.patchKey,
        hint,
      });
      if (warning !== undefined) {
        clauseWarnings.push(warning);
      }
    }
    const patch = renderClauseSlot({
      slot,
      body,
      clause,
      values: record,
      namedConditions,
    });
    if (Result.isError(patch)) {
      return Result.err(patch.error);
    }
    record[slot.patchKey] = patch.value;
  }

  return Result.ok(clauseWarnings);
};

const clauseGroundingTexts = ({
  bodies,
  record,
  namedConditions,
}: Pick<
  ApplyClausePatchesOptions,
  "bodies" | "record" | "namedConditions"
>): Result<string[], HandlerError<422>> => {
  const texts: string[] = [];
  for (const [slotKey, body] of Object.entries(bodies)) {
    const patch = clauseBodyToRichPatch(body, {
      source: "stored",
      values: record,
      slotKey,
      namedConditions,
    });
    if (Result.isError(patch)) {
      return Result.err(patch.error);
    }
    const text =
      typeof patch.value === "string"
        ? patch.value
        : patch.value.paragraphs
            .map(({ runs }) =>
              runs.map(({ text: runText }) => runText).join(""),
            )
            .join("\n");
    // AI fields still awaiting drafts are absent from the grounding text.
    const resolved = replaceOutputMarkers(text, () => "");
    record[slotKey] = resolved;
    texts.push(resolved);
  }
  return Result.ok(texts);
};

type DocumentGroundingOptions = {
  file: ScannedFile;
  manifest: TemplateManifest;
  bodies: Record<string, ClauseBody>;
  record: FillValues;
};

const documentGrounding = async ({
  file,
  manifest,
  bodies,
  record,
}: DocumentGroundingOptions): Promise<
  Result<string | undefined, HandlerError<422>>
> => {
  if (!isTemplateData(record)) {
    return Result.err(
      new HandlerError({
        status: 422,
        message:
          "Values must be strings, numbers, booleans, arrays, or nested objects.",
      }),
    );
  }
  const templateText = await documentTextForAiFields(file, manifest.fields);
  const clauseTexts = clauseGroundingTexts({
    bodies,
    record,
    namedConditions: manifestNamedConditions(manifest),
  });
  if (Result.isError(clauseTexts)) {
    return Result.err(clauseTexts.error);
  }
  return Result.ok(
    templateText === undefined
      ? undefined
      : [templateText, ...clauseTexts.value].join("\n"),
  );
};

type UnusedFilledValuesOptions = {
  unusedValues: string[];
  slots: ApplyClausePatchesOptions["slots"];
  bodies: ApplyClausePatchesOptions["bodies"];
  adaptedPaths: string[];
  defaultedPaths: string[];
  clauseFieldPaths: DiscoveredTemplate["clauseFieldPaths"];
};

const unusedFilledValues = ({
  unusedValues,
  slots,
  bodies,
  adaptedPaths,
  defaultedPaths,
  clauseFieldPaths,
}: UnusedFilledValuesOptions): string[] =>
  unusedValues.filter(
    (name) =>
      !slots.some(
        (slot) => slot.patchKey === name && bodies[name] !== undefined,
      ) &&
      !adaptedPaths.includes(name) &&
      !defaultedPaths.includes(name) &&
      !clauseFieldPaths?.some(
        (path) => path === name || name.startsWith(`${path}.`),
      ),
  );

type FillInputContractOptions = {
  manifest: TemplateManifest;
  discovered: DiscoveredTemplate;
};

const templateFillInputContract = ({
  manifest,
  discovered,
}: FillInputContractOptions) => {
  const rawInputSources = collectRawTemplateInputSources({
    fields: discovered.fields,
    placeholderPaths: discovered.placeholders.map(
      (placeholder) => placeholder.name,
    ),
  });
  return collectTemplateInputKeys({
    type: "manifest",
    derivedOutputPaths: manifest.fields.flatMap((field) => {
      const paths = isFillableTemplateInputField(field) ? [] : [field.path];
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
};

type PrepareFillAdmissionOptions<TRejection> = Pick<
  FillDocxWithPolicyOptions<TRejection>,
  "values" | "requiredFields" | "unusedValuePolicy" | "aiCollaborators"
> &
  Awaited<ReturnType<typeof discoverTemplateSource>> & { file: ScannedFile };

const prepareFillAdmission = async <TRejection>({
  values,
  requiredFields,
  unusedValuePolicy,
  manifest,
  discovered,
  slots,
  bodies,
  clauses,
  file,
  aiCollaborators,
}: PrepareFillAdmissionOptions<TRejection>) => {
  const namedConditions = manifestNamedConditions(manifest);
  const requiredGate = requiredFieldsGate({
    manifest,
    discovered,
    requiredFields,
  });
  const invalidOverrides = invalidAuthoredClauseOverrides({
    slots,
    bodies,
    clauses,
  });
  // When the submitted values already decide what renders, read it once, so
  // required fields and authored overrides are judged before quota checks,
  // lookups or AI work; otherwise both wait for the values the fill renders.
  const earlyResult =
    renderingSettledBeforeFillSteps(manifest, discovered) &&
    isTemplateData(values) &&
    (requiredGate.readsRendering || invalidOverrides.length > 0)
      ? await renderedFill({
          file,
          discovered,
          values,
          bodies,
          namedConditions,
        })
      : null;
  if (earlyResult !== null && Result.isError(earlyResult)) {
    return {
      type: "refused" as const,
      rejection: {
        error: earlyResult.error.message,
        storedTemplateError: earlyResult.error,
      },
    };
  }
  const earlyRendering = earlyResult?.value ?? null;
  if (earlyRendering !== null) {
    const overrides = settleInvalidOverrides(
      invalidOverrides,
      earlyRendering.slots,
    );
    if (Result.isError(overrides)) {
      return {
        type: "refused" as const,
        rejection: {
          error: overrides.error.message,
          storedTemplateError: overrides.error,
        },
      };
    }
  }
  let strictInputPlaceholders: string[] | null = null;

  if (unusedValuePolicy === "reject") {
    strictInputPlaceholders = discovered.placeholders.map(
      (placeholder) => placeholder.name,
    );
    const inputContract = templateFillInputContract({ manifest, discovered });
    const unusedKeys = findUnusedTemplateValueKeys({
      contract: inputContract,
      values,
    });
    if (unusedKeys.length > 0) {
      return {
        type: "refused" as const,
        rejection: {
          inputRejection: { type: "unused-values" as const, keys: unusedKeys },
        },
      };
    }
  }

  const missingRequiredFields = requiredGate.early(values, earlyRendering);
  if (missingRequiredFields.length > 0) {
    return {
      type: "refused" as const,
      rejection: { requiredFieldsRejection: missingRequiredFields },
    };
  }

  // Gate AI preflight and collaborators on declared model work: deterministic
  // fills spend neither quota nor config reads, and refusals precede lookups.
  const hasAiFields = manifest.fields.some(
    (field) => Boolean(field.aiPrompt) || field.aiAdapt === true,
  );
  let collaborators: AiFillCollaborators = {};
  if (aiCollaborators && hasAiFields) {
    const authorization = await aiCollaborators();
    if (Result.isError(authorization)) {
      return {
        type: "refused" as const,
        rejection: { usageRejection: authorization.error },
      };
    }
    collaborators = await authorization.value.execute(
      async ({ input }) => await input.value.buildCollaborators(),
    );
  }
  const { generateAiValue, decideAiCondition, adaptAiValue } = collaborators;

  return {
    type: "prepared" as const,
    generateAiValue,
    decideAiCondition,
    adaptAiValue,
    namedConditions,
    requiredGate,
    invalidOverrides,
    earlyRendering,
    strictInputPlaceholders,
  };
};

type SettleRenderedFillOptions = RenderedFillOptions & {
  earlyRendering: RenderedFill | null;
  requiredGate: ReturnType<typeof requiredFieldsGate>;
  invalidOverrides: readonly InvalidOverride[];
};

const settleRenderedFill = async ({
  earlyRendering,
  requiredGate,
  invalidOverrides,
  ...options
}: SettleRenderedFillOptions) => {
  const finalResult = await renderedFill(options);
  if (Result.isError(finalResult)) {
    return {
      type: "refused" as const,
      rejection: {
        error: finalResult.error.message,
        storedTemplateError: finalResult.error,
      },
    };
  }
  const finalRendering = finalResult.value;
  if (earlyRendering === null && requiredGate.readsRendering) {
    const missing = requiredGate.late(options.values, finalRendering);
    if (missing.length > 0) {
      return {
        type: "refused" as const,
        rejection: { requiredFieldsRejection: missing },
      };
    }
  }
  const overrides = settleInvalidOverrides(
    invalidOverrides,
    finalRendering.slots,
  );
  if (Result.isError(overrides)) {
    return {
      type: "refused" as const,
      rejection: {
        error: overrides.error.message,
        storedTemplateError: overrides.error,
      },
    };
  }
  return {
    type: "rendered" as const,
    renderedSlots: finalRendering.slots,
    clauseWarnings: overrides.value,
  };
};

/**
 * Shared fill recipe over an already-loaded DOCX: discover linked content,
 * gate required fields, run manifest fill steps (lookups, composites, formulas,
 * dependent selects), draft/adapt AI fields, resolve clause directives, then
 * substitute. Records the template use when a `templateId` is present.
 * Backs every fill boundary, so a template fills identically at each of them.
 */
const fillTemplateDocxWithPolicy = async <TRejection = never>(
  options: FillDocxWithPolicyOptions<TRejection>,
): Promise<FilledDocx | FillRejection<TRejection>> => {
  const {
    source,
    values,
    scopedDb,
    organizationId,
    thirdPartyOutboundPermit,
    requiredFields,
    clauseOverrides,
    aiCollaborators,
    lookupResolver,
    useRecording = "after-fill",
    workspaceId,
    unusedValuePolicy,
  } = snapshotOperationInput(options);
  const { templateId } = source;
  const { manifest, discovered, slots, bodies, clauses } =
    await discoverTemplateSource({
      source,
      scopedDb,
      organizationId,
      clauseOverrides,
    });
  const input = await prepareFillAdmission({
    aiCollaborators,
    values,
    requiredFields,
    unusedValuePolicy,
    manifest,
    discovered,
    slots,
    bodies,
    clauses,
    file: source.file,
  });
  switch (input.type) {
    case "refused":
      return input.rejection;
    case "prepared":
      break;
    default:
      input satisfies never;
      return panic("Unhandled prepared template input");
  }
  const {
    namedConditions,
    requiredGate,
    invalidOverrides,
    earlyRendering,
    strictInputPlaceholders,
    generateAiValue,
    decideAiCondition,
    adaptAiValue,
  } = input;

  let record = cloneOperationInput(values);
  const resolveLookup = await fillLookupResolver({
    permit: thirdPartyOutboundPermit,
    lookupResolver,
    scopedDb,
    organizationId,
  });

  const drafting = await draftDocumentValues({
    file: source.file,
    manifest,
    bodies,
    record,
    discovered,
    resolveLookup,
    scopedDb,
    organizationId,
    workspaceId,
    generateAiValue,
    decideAiCondition,
  });
  if (drafting.type === "fields-refused") {
    return { error: drafting.error };
  }
  if (drafting.type === "refused") {
    return {
      error: drafting.error.message,
      storedTemplateError: drafting.error,
    };
  }
  record = drafting.values;
  const { conditionDecisions } = drafting;
  // Rewrite each aiAdapt marker occurrence to fit its surrounding text;
  // the stub stays in `record` so uncovered occurrences still get the
  // plain global substitution below.
  const adapted = await adaptAiFields({
    file: source.file,
    fields: manifest.fields,
    values: record,
    adapt: adaptAiValue,
  });
  const { file: fillSource, adaptedPaths } = adapted;
  const aiFieldErrors = [...drafting.aiFieldErrors, ...adapted.failures];

  const optionalDefaults = applyOmittedOptionalPlaceholderDefaults({
    fields: manifest.fields,
    placeholderPaths: arrayOrEmpty(strictInputPlaceholders),
    values: record,
  });
  record = optionalDefaults.values;

  if (!isTemplateData(record)) {
    return {
      error:
        "Values must be strings, numbers, booleans, arrays, or nested objects.",
    };
  }

  const prepared = await prepareClauseOccurrences({
    file: fillSource,
    record,
    discovered,
    manifest,
    namedConditions,
    resolveLookup,
    bindingContext: drafting.bindingContext,
    generateAiValue,
    decideAiCondition,
    documentText: drafting.grounding,
  });
  if (prepared.type === "refused") {
    return prepared.rejection;
  }
  aiFieldErrors.push(...prepared.aiFieldErrors);
  conditionDecisions.push(...prepared.conditionDecisions);

  const settled = await settleRenderedFill({
    file: fillSource,
    discovered,
    values: record,
    bodies,
    namedConditions,
    occurrenceValues: prepared.occurrenceValues,
    earlyRendering,
    requiredGate,
    invalidOverrides,
  });
  switch (settled.type) {
    case "refused":
      return settled.rejection;
    case "rendered":
      break;
    default:
      settled satisfies never;
      return panic("Unhandled rendered fill settlement");
  }
  const { renderedSlots } = settled;

  const rendered = await fillWithClauseSlots({
    file: fillSource,
    occurrenceValues: prepared.occurrenceValues,
    slots,
    bodies,
    clauses,
    record,
    namedConditions,
    renderedSlots,
  });
  if (Result.isError(rendered)) {
    return {
      error: rendered.error.message,
      storedTemplateError: rendered.error,
    };
  }
  const { result } = rendered.value;
  const clauseWarnings = [
    ...settled.clauseWarnings,
    ...rendered.value.clauseWarnings,
  ];

  if (templateId !== undefined && useRecording === "after-fill") {
    await scopedDb(async (tx) => {
      await recordTemplateUse({ tx, templateId });
    });
  }

  return {
    templateName: source.name,
    fileName: source.fileName,
    file: result.file,
    unmatchedPlaceholders: result.unmatchedPlaceholders,
    unusedValues: unusedFilledValues({
      unusedValues: result.unusedValues,
      slots,
      bodies,
      adaptedPaths,
      defaultedPaths: optionalDefaults.defaultedPaths,
      clauseFieldPaths: discovered.clauseFieldPaths,
    }),
    structureErrors: result.structureErrors,
    aiFieldErrors,
    conditionDecisions,
    clauseWarnings,
  };
};

export const fillTemplateDocx = async <TRejection = never>(
  options: FillDocxOptions<TRejection>,
): Promise<
  | FilledDocx
  | TemplateServiceError
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
export const fillStoredTemplateDocx = async <TRejection = never>(
  input: FillServiceOptions<TRejection>,
): Promise<
  | FilledDocx
  | TemplateServiceError
  | { requiredFieldsRejection: MissingRequiredField[] }
  | { usageRejection: TRejection }
> => {
  const { templateId, ...options } = snapshotOperationInput(input);
  const loaded = await loadStoredTemplateSource({
    templateId,
    organizationId: options.organizationId,
    scopedDb: options.scopedDb,
  });
  if (Result.isError(loaded)) {
    return storedTemplateLoadError(loaded.error);
  }

  return await fillTemplateDocx({ ...options, source: loaded.value });
};

export type FillTemplateResult =
  | {
      text: string;
      unmatchedPlaceholders: string[];
      unusedValues: string[];
      structureErrors: FilledDocx["structureErrors"];
      /** AI-drafted fields the model could not complete; unfilled above. */
      aiFieldErrors: AiFieldError[];
      /** What each AI-decided condition was settled on, and by whom. */
      conditionDecisions: ResolvedAiCondition[];
      clauseWarnings: ClauseDirectiveWarning[];
    }
  | TemplateServiceError
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
      file: ScannedFile;
      text: string;
      unmatchedPlaceholders: string[];
      unusedValues: string[];
      structureErrors: FilledDocx["structureErrors"];
      aiFieldErrors: AiFieldError[];
      /** What each AI-decided condition was settled on, and by whom. */
      conditionDecisions: ResolvedAiCondition[];
      clauseWarnings: ClauseDirectiveWarning[];
    }
  | TemplateServiceError;

type FilledTemplateWithText = Exclude<
  FillTemplateWithDocxResult,
  { error: string }
>;

const withExtractedText = async (
  filled: FilledDocx,
): Promise<FilledTemplateWithText> => {
  const { paragraphs } = await extractDocxDocument(filled.file);
  return {
    templateName: filled.templateName,
    fileName: filled.fileName,
    file: filled.file,
    text: paragraphs
      .map((paragraph) => paragraph.text)
      .join("\n")
      .trim(),
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    unusedValues: filled.unusedValues,
    structureErrors: filled.structureErrors,
    aiFieldErrors: filled.aiFieldErrors,
    conditionDecisions: filled.conditionDecisions,
    clauseWarnings: filled.clauseWarnings,
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

export const fillStoredTemplateWithTextStrict = async <TRejection = never>(
  input: FillServiceOptions<TRejection>,
): Promise<
  | FillTemplateWithDocxResult
  | { inputRejection: TemplateInputRejection }
  | { requiredFieldsRejection: MissingRequiredField[] }
  | { usageRejection: TRejection }
> => {
  const { templateId, ...options } = snapshotOperationInput(input);
  const loaded = await loadStoredTemplateSource({
    templateId,
    organizationId: options.organizationId,
    scopedDb: options.scopedDb,
  });
  if (Result.isError(loaded)) {
    return storedTemplateLoadError(loaded.error);
  }
  const filled = await fillTemplateDocxStrict({
    ...options,
    source: loaded.value,
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

export const fillStoredTemplate = async <TRejection = never>(
  options: FillServiceOptions<TRejection>,
): Promise<FillTemplateResult | { usageRejection: TRejection }> => {
  const filled = await fillStoredTemplateDocx(options);
  if ("usageRejection" in filled) {
    return filled;
  }
  if ("requiredFieldsRejection" in filled) {
    return filled;
  }
  if ("error" in filled) {
    return filled;
  }

  const { paragraphs } = await extractDocxDocument(filled.file);

  return {
    text: paragraphs
      .map((paragraph) => paragraph.text)
      .join("\n")
      .trim(),
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    unusedValues: filled.unusedValues,
    structureErrors: filled.structureErrors,
    aiFieldErrors: filled.aiFieldErrors,
    conditionDecisions: filled.conditionDecisions,
    clauseWarnings: filled.clauseWarnings,
  };
};
