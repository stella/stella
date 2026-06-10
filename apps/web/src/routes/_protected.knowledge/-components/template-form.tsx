import { useEffect, useCallback, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import {
  AlertTriangleIcon,
  LandmarkIcon,
  PlusIcon,
  TrashIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { evaluateCondition } from "@stll/template-conditions";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Field, FieldControl, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { MatterTargetPicker } from "@/components/matter-target-picker";
import type { MatterTarget } from "@/components/matter-target-picker";
import Tooltip from "@/components/tooltip";
import { api } from "@/lib/api";
import { DOCX_MIME, PDF_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

import {
  buildAutofillUpdates,
  groupSupportsRegistryAutofill,
} from "./registry-autofill";
import {
  firstOfNextMonthIso,
  formatDateValue,
  inDaysIso,
  todayIso,
} from "./template-date-format";
import { TemplatePrefillPanel } from "./template-prefill-panel";
import type { PrefillSuggestionDto } from "./template-prefill-panel";

type FillFormat = "docx" | "pdf";

const DOCX_EXT_RE = /\.docx$/iu;

type DiscoverResponse = Awaited<ReturnType<typeof api.templates.discover.post>>;

type DiscoverData = Exclude<
  NonNullable<Extract<DiscoverResponse, { data: unknown }>["data"]>,
  Response
>;

type ResolvedField = DiscoverData["fields"][number];
type NamedCondition = DiscoverData["conditions"][number];
type StructureError = DiscoverData["structureErrors"][number];

const REQUIRED_MARKER = "*";

type CompositePart = NonNullable<ResolvedField["parts"]>[number];

/** The field's parts when it is composite (parts + format), else null. */
const compositeParts = (field: ResolvedField): CompositePart[] | null =>
  field.parts !== undefined &&
  field.parts.length > 0 &&
  field.format !== undefined
    ? field.parts
    : null;

/** Read a composite field's form value into a part-key → string map. */
const readPartValues = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, partValue] of Object.entries(value)) {
    if (typeof partValue === "string") {
      out[key] = partValue;
    }
  }
  return out;
};

/** Mirrors `validateKrsNumber` from the business-registries package (not
 *  exposed to the web workspace): exactly 10 digits, whitespace-tolerant. */
const KRS_NUMBER_RE = /^\d{10}$/u;

const isValidKrsNumber = (value: string): boolean =>
  KRS_NUMBER_RE.test(value.replaceAll(/\s/gu, ""));

type FieldErrors = Record<string, string | undefined>;
type TouchedFields = Record<string, boolean>;

type ValidationError =
  | { kind: "required" }
  | { kind: "minLength"; min: number }
  | { kind: "maxLength"; max: number }
  | { kind: "numberMin"; min: number }
  | { kind: "numberMax"; max: number }
  | { kind: "pattern" }
  | { kind: "optionNotInSource"; source: string }
  | { kind: "lookupNumber" }
  | { kind: "minItems"; min: number };

/** Validate a composite field's part values. */
const validateCompositeField = (
  parts: CompositePart[],
  value: unknown,
  required: boolean,
): ValidationError | undefined => {
  const partValues = readPartValues(value);
  const isFilled = (part: CompositePart) =>
    (partValues[part.key] ?? "").trim() !== "";
  const filledCount = parts.filter(isFilled).length;
  if (filledCount === 0) {
    return required ? { kind: "required" } : undefined;
  }
  // A partially filled composite cannot be assembled: once any part is
  // entered, every part is required (required field = all parts required).
  if (filledCount < parts.length) {
    return { kind: "required" };
  }
  for (const part of parts) {
    if (part.pattern === undefined || part.pattern === "") {
      continue;
    }
    try {
      // Anchored: the pattern must describe the whole part value (same
      // rule the server applies at fill time).
      const re = new RegExp(`^(?:${part.pattern})$`, "u");
      if (!re.test(partValues[part.key] ?? "")) {
        return { kind: "pattern" };
      }
    } catch {
      // Invalid regex in manifest; skip the check
    }
  }
  return undefined;
};

/** Validate a single field value against its manifest
 *  rules. Returns a validation error or undefined. */
const validateField = (
  field: ResolvedField,
  value: unknown,
): ValidationError | undefined => {
  const required = field.required ?? field.validation?.required ?? false;

  const parts = compositeParts(field);
  if (parts) {
    return validateCompositeField(parts, value, required);
  }

  const str = typeof value === "string" ? value : "";

  if (required && str.trim() === "" && value !== true) {
    return { kind: "required" };
  }

  // Length / pattern only apply to string inputs
  if (str.length === 0) {
    return undefined;
  }

  // A lookup field's value is the registry number itself (the server resolves
  // it into the company details); check the number format before submit so a
  // typo fails locally instead of as a server-side lookup error.
  if (field.lookup?.registry === "krs" && !isValidKrsNumber(str)) {
    return { kind: "lookupNumber" };
  }

  const { minLength, maxLength, min, max, pattern } = field.validation ?? {};

  // Numeric range checks for number inputs
  if (field.inputType === "number") {
    const num = Number(str);
    if (!Number.isNaN(num)) {
      if (min !== undefined && num < min) {
        return { kind: "numberMin", min };
      }
      if (max !== undefined && num > max) {
        return { kind: "numberMax", max };
      }
    }
  }

  if (minLength !== undefined && minLength > 0 && str.length < minLength) {
    return { kind: "minLength", min: minLength };
  }

  if (maxLength !== undefined && maxLength > 0 && str.length > maxLength) {
    return { kind: "maxLength", max: maxLength };
  }

  if (pattern !== undefined && pattern !== "") {
    try {
      const re = new RegExp(pattern, "u");
      if (!re.test(str)) {
        return { kind: "pattern" };
      }
    } catch {
      // Invalid regex in manifest; skip the check
    }
  }

  return undefined;
};

type TemplateFormBaseProps = {
  fields: ResolvedField[];
  conditions: NamedCondition[];
  structureErrors: StructureError[];
  onBack: () => void;
  onDone: (filename: string) => void;
};

/** Transient fill: uploads the file alongside values. */
type TransientFillProps = TemplateFormBaseProps & {
  file: File;
  templateId?: undefined;
  fileName?: undefined;
};

/** Server-side fill: sends only values; server reads S3. */
type ServerFillProps = TemplateFormBaseProps & {
  templateId: string;
  fileName: string;
  file?: undefined;
};

/** Where the filled document can land (server-side fill only): a fixed
 *  matter (the form was opened from one) or a matter the user picks at the
 *  end. Without it the form offers the existing downloads only. */
type SaveTarget =
  | {
      kind: "matter";
      workspaceId: string;
      parentId?: string | null | undefined;
      onCreated: (entityId: string) => void;
    }
  | {
      kind: "chooseMatter";
      onCreated: (created: { workspaceId: string; entityId: string }) => void;
    };

type TemplateFormProps = (TransientFillProps | ServerFillProps) & {
  /** Live values tap for hosts that preview the fill elsewhere. */
  onValuesChange?: (values: Record<string, unknown>) => void;
  /** Persist the filled DOCX as a matter document (server-side fill only). */
  saveTarget?: SaveTarget | undefined;
  /** Show the AI "prefill from documents" panel (server-side fill only);
   *  pass the current matter's id to also offer its stored documents. */
  prefill?: { workspaceId?: string | undefined } | undefined;
};

type FormValues = Record<string, unknown>;

/** Form-state key holding an array field's item index list (`number[]`),
 *  bookkeeping rather than a field value. Single source of the array key
 *  naming scheme; hosts tapping `onValuesChange` parse keys through this
 *  and {@link parseArrayItemKey}. */
export const ARRAY_INDEX_KEY_PREFIX = "__array_";

const arrayIndexKey = (fieldPath: string): string =>
  `${ARRAY_INDEX_KEY_PREFIX}${fieldPath}`;

/** Array item inputs as named by ArrayFieldRenderer: `<path>[<index>].<sub>`. */
const ARRAY_ITEM_KEY_RE = /^(.+)\[(\d+)\]\.(.+)$/u;

export type ArrayItemKey = {
  /** The array field's path. */
  path: string;
  index: number;
  /** The item sub-field's path within the array field. */
  sub: string;
};

/** Parse a form-state key into its array item parts; null for scalar keys. */
export const parseArrayItemKey = (key: string): ArrayItemKey | null => {
  const match = ARRAY_ITEM_KEY_RE.exec(key);
  const [, path, index, sub] = match ?? [];
  if (path === undefined || index === undefined || sub === undefined) {
    return null;
  }
  return { path, index: Number(index), sub };
};

/**
 * Read an `__array_*` key from form state into a `number[]` index list.
 * Returns `[]` when the key is missing or holds a non-number-array value;
 * runtime validation absorbs the previous unchecked cast.
 */
const readArrayIndices = (values: FormValues, arrayKey: string): number[] => {
  const raw = values[arrayKey];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is number => typeof item === "number");
};

/** Current values of the field referenced by `optionsFrom`, gathered from
 *  live form state: a scalar sibling contributes its value, an array item
 *  path (`parties.name`) contributes every item's entry. Deduplicated,
 *  blanks dropped. */
const collectSourceOptionValues = (
  sourcePath: string,
  fields: readonly ResolvedField[],
  values: FormValues,
): string[] => {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      !out.includes(value)
    ) {
      out.push(value);
    }
  };

  for (const field of fields) {
    if (field.kind === "array") {
      const sub = (field.itemFields ?? []).find(
        (item) => `${field.path}.${item.path}` === sourcePath,
      );
      if (!sub) {
        continue;
      }
      const count = readArrayIndices(values, arrayIndexKey(field.path)).length;
      for (let i = 0; i < count; i++) {
        push(values[`${field.path}[${String(i)}].${sub.path}`]);
      }
      return out;
    }
    if (field.path === sourcePath) {
      push(values[field.path]);
      return out;
    }
  }
  return out;
};

/** Live options for a select with `optionsFrom`: the referenced field's
 *  current values, falling back to the static options while the source is
 *  empty. Null when the field has no source. */
const dependentOptions = (
  field: ResolvedField,
  fields: readonly ResolvedField[],
  values: FormValues,
): string[] | null => {
  if (field.optionsFrom === undefined) {
    return null;
  }
  const sourceValues = collectSourceOptionValues(
    field.optionsFrom,
    fields,
    values,
  );
  return sourceValues.length > 0 ? sourceValues : (field.options ?? []);
};

/** Label of the top-level field that supplies a dependent select's options
 *  (the array field itself for an item path like `parties.name`). */
const sourceFieldLabel = (
  sourcePath: string,
  fields: readonly ResolvedField[],
): string => {
  const source = fields.find(
    (f) =>
      f.path === sourcePath ||
      (f.kind === "array" &&
        (f.itemFields ?? []).some(
          (item) => `${f.path}.${item.path}` === sourcePath,
        )),
  );
  return source?.label ?? sourcePath;
};

/** Validate a dependent (optionsFrom) select against its source's current
 *  values: a chosen value that the user has since removed from the source
 *  must be re-picked before submitting. */
const validateDependentSelection = (
  field: ResolvedField,
  value: unknown,
  fields: readonly ResolvedField[],
  values: FormValues,
): ValidationError | undefined => {
  if (
    field.optionsFrom === undefined ||
    typeof value !== "string" ||
    value === ""
  ) {
    return undefined;
  }
  const options = dependentOptions(field, fields, values);
  if (options === null || options.length === 0 || options.includes(value)) {
    return undefined;
  }
  return {
    kind: "optionNotInSource",
    source: sourceFieldLabel(field.optionsFrom, fields),
  };
};

const groupFieldsByPrefix = (fields: readonly ResolvedField[]) => {
  const groups = new Map<string, ResolvedField[]>();

  for (const field of fields) {
    const dotIndex = field.path.indexOf(".");
    const prefix = dotIndex > 0 ? field.path.slice(0, dotIndex) : "";
    const existing = groups.get(prefix) ?? [];
    existing.push(field);
    groups.set(prefix, existing);
  }

  return groups;
};

const getDefaultValue = (field: ResolvedField): unknown => {
  if (compositeParts(field)) {
    return {};
  }
  if (field.kind === "boolean") {
    return false;
  }
  if (field.kind === "array") {
    return [];
  }
  return "";
};

const buildInitialValues = (fields: readonly ResolvedField[]): FormValues => {
  const values: FormValues = {};
  for (const field of fields) {
    if (field.kind !== "array") {
      values[field.path] = getDefaultValue(field);
    }
  }
  return values;
};

/**
 * Check if a field is visible given current form values
 * and named conditions. Returns true if the field has no
 * `visibleWhen` condition, or if the condition evaluates
 * to true.
 */
const isFieldVisible = (
  field: ResolvedField,
  values: FormValues,
  conditions: readonly NamedCondition[],
): boolean => {
  if (!field.visibleWhen) {
    return true;
  }
  return evaluateCondition(field.visibleWhen, values, conditions);
};

const RequiredIndicator = () => (
  <span className="text-destructive-foreground">{REQUIRED_MARKER}</span>
);

/** Wand badge on an AI-prefilled input; hovering shows the source snippet
 *  that supports the proposed value. Clearing the value removes it. */
const PrefillBadge = ({ snippet }: { snippet?: string | null | undefined }) => {
  const t = useTranslations();
  if (snippet === undefined) {
    return null;
  }
  return (
    <Tooltip
      className="text-wrap"
      content={snippet ?? t("templates.prefillBadgeLabel")}
      render={
        <span className="text-muted-foreground ms-1 inline-flex align-middle" />
      }
    >
      <WandSparklesIcon
        aria-label={t("templates.prefillBadgeLabel")}
        className="size-3.5"
      />
    </Tooltip>
  );
};

const FieldError = ({ message }: { message?: string | undefined }) => {
  if (!message) {
    return null;
  }
  return <p className="text-destructive-foreground text-sm">{message}</p>;
};

/** Shown under aiAdapt fields: the typed value is a stub that AI rewords to
 *  fit the surrounding sentence at each place it appears in the document. */
const AiAdaptHint = ({ show }: { show: boolean }) => {
  const t = useTranslations();
  if (!show) {
    return null;
  }
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <WandSparklesIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {t("templates.aiAdaptHint")}
    </p>
  );
};

/** Quick picks under a date input: common contract dates entered as one
 *  click (today, the first of next month, 30 days out). */
const DateQuickChips = ({ onPick }: { onPick: (iso: string) => void }) => {
  const t = useTranslations();
  const chips = [
    { key: "today", label: t("common.today"), iso: todayIso },
    {
      key: "firstOfNextMonth",
      label: t("templates.dateChipFirstOfNextMonth"),
      iso: firstOfNextMonthIso,
    },
    {
      key: "plus30",
      label: t("templates.dateChipPlus30Days"),
      iso: () => inDaysIso(30),
    },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <button
          className="bg-accent text-accent-foreground hover:bg-accent/80 cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium"
          key={chip.key}
          onClick={() => onPick(chip.iso())}
          type="button"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
};

/** How the entered date will render in the generated document, per the
 *  field's manifest dateFormat. Hidden while empty/invalid, and for the
 *  pass-through "iso" style (the input already shows that value). */
const DateRenderPreview = ({
  dateFormat,
  value,
}: {
  dateFormat: ResolvedField["dateFormat"];
  value: unknown;
}) => {
  const t = useTranslations();
  if (
    dateFormat === undefined ||
    dateFormat.style === "iso" ||
    typeof value !== "string" ||
    value === ""
  ) {
    return null;
  }
  const formatted = formatDateValue(value, dateFormat);
  if (formatted === null) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs">
      {t("templates.dateRenderPreview", { value: formatted })}
    </p>
  );
};

/** Shown under registry-lookup fields: the entered number (e.g. KRS) is
 *  resolved against the register at fill time and replaced with the rendered
 *  company details. */
const LookupHint = ({ lookup }: { lookup: ResolvedField["lookup"] }) => {
  const t = useTranslations();
  if (!lookup) {
    return null;
  }
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <LandmarkIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {t("templates.lookupFieldHint")}
    </p>
  );
};

/** One visual row for a composite field: one input per part (select or
 *  text), labelled by the field's label; the form value is the object of
 *  part values, assembled by the server at fill time. */
const CompositeFieldRow = ({
  field,
  parts,
  label,
  required,
  value,
  onChange,
  onBlur,
  error,
  prefillSnippet,
}: {
  field: ResolvedField;
  parts: CompositePart[];
  label: string;
  required: boolean;
  value: unknown;
  onChange: (path: string, value?: unknown) => void;
  onBlur?: ((path: string) => void) | undefined;
  error?: string | undefined;
  prefillSnippet?: string | null | undefined;
}) => {
  const partValues = readPartValues(value);
  const setPart = (key: string, partValue: string) =>
    onChange(field.path, { ...partValues, [key]: partValue });

  return (
    <Field>
      <FieldLabel>
        {label}
        {required && <RequiredIndicator />}
        <PrefillBadge snippet={prefillSnippet} />
      </FieldLabel>
      <div className="flex flex-wrap items-start gap-2">
        {parts.map((part) => {
          const partLabel = part.label ?? part.key;
          if (
            part.inputType === "select" &&
            part.options &&
            part.options.length > 0
          ) {
            const selected = partValues[part.key];
            return (
              <Select
                key={part.key}
                name={`${field.path}.${part.key}`}
                onValueChange={(val) => {
                  setPart(part.key, typeof val === "string" ? val : "");
                  onBlur?.(field.path);
                }}
                value={selected === "" ? undefined : selected}
              >
                <SelectTrigger
                  aria-label={partLabel}
                  className="w-auto min-w-36"
                >
                  <SelectValue placeholder={partLabel} />
                </SelectTrigger>
                <SelectPopup>
                  {part.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            );
          }
          return (
            <Input
              aria-label={partLabel}
              className="min-w-36 flex-1"
              key={part.key}
              name={`${field.path}.${part.key}`}
              onBlur={() => onBlur?.(field.path)}
              onChange={(e) => setPart(part.key, e.target.value)}
              placeholder={partLabel}
              type="text"
              value={partValues[part.key] ?? ""}
            />
          );
        })}
      </div>
      <FieldError message={error} />
    </Field>
  );
};

const FieldRenderer = ({
  field,
  value,
  onChange,
  onBlur,
  error,
  derivedOptions,
  prefillSnippet,
}: {
  field: ResolvedField;
  value: unknown;
  onChange: (path: string, value?: unknown) => void;
  onBlur?: ((path: string) => void) | undefined;
  error?: string | undefined;
  /** Live options for a dependent (optionsFrom) select, derived by the form
   *  from the source field's current values; overrides `field.options`. */
  derivedOptions?: string[] | undefined;
  /** Set when the value was AI-prefilled: the supporting source snippet
   *  (null when the model gave none). Undefined hides the badge. */
  prefillSnippet?: string | null | undefined;
}) => {
  const locale = useLocale();
  const inputType =
    field.inputType ?? (field.kind === "boolean" ? "boolean" : "text");
  const label = field.label ?? field.path;
  const required = field.required ?? field.validation?.required ?? false;
  const handleBlur = () => onBlur?.(field.path);

  // A composite field renders one input per part on a single row; its form
  // value is the object of part values, assembled by the server at fill time.
  const parts = compositeParts(field);
  if (parts) {
    return (
      <CompositeFieldRow
        error={error}
        field={field}
        label={label}
        onBlur={onBlur}
        onChange={onChange}
        parts={parts}
        prefillSnippet={prefillSnippet}
        required={required}
        value={value}
      />
    );
  }

  if (inputType === "boolean" || field.kind === "boolean") {
    return (
      <Field>
        <div className="flex items-center gap-2">
          <Checkbox
            checked={value === true}
            onCheckedChange={(checked) => {
              onChange(field.path, checked);
              onBlur?.(field.path);
            }}
          />
          <FieldLabel>
            {label}
            {required && <RequiredIndicator />}
            <PrefillBadge snippet={prefillSnippet} />
          </FieldLabel>
        </div>
        <FieldError message={error} />
      </Field>
    );
  }

  // A dependent select keeps its select rendering even while it has no
  // options yet (the source field is still empty): a text input would lift
  // the subset constraint, so the trigger is disabled instead.
  const selectOptions = derivedOptions ?? field.options ?? [];
  if (
    inputType === "select" &&
    (selectOptions.length > 0 || field.optionsFrom !== undefined)
  ) {
    return (
      <Field>
        <FieldLabel>
          {label}
          {required && <RequiredIndicator />}
          <PrefillBadge snippet={prefillSnippet} />
        </FieldLabel>
        <Select
          disabled={selectOptions.length === 0}
          name={field.path}
          onValueChange={(val) => {
            onChange(field.path, val);
            onBlur?.(field.path);
          }}
          value={value === "" || typeof value !== "string" ? undefined : value}
        >
          <SelectTrigger>
            <SelectValue placeholder={field.hint ?? label} />
          </SelectTrigger>
          <SelectPopup>
            {selectOptions.map((option: string) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <FieldError message={error} />
      </Field>
    );
  }

  if (inputType === "textarea") {
    return (
      <Field>
        <FieldLabel>
          {label}
          {required && <RequiredIndicator />}
          <PrefillBadge snippet={prefillSnippet} />
        </FieldLabel>
        <FieldControl
          render={
            <Textarea
              name={field.path}
              onBlur={handleBlur}
              onChange={(e) => onChange(field.path, e.target.value)}
              placeholder={field.hint}
              value={typeof value === "string" ? value : ""}
            />
          }
        />
        <AiAdaptHint show={field.aiAdapt === true} />
        <FieldError message={error} />
      </Field>
    );
  }

  if (inputType === "number") {
    return (
      <Field>
        <FieldLabel>
          {label}
          {required && <RequiredIndicator />}
          <PrefillBadge snippet={prefillSnippet} />
        </FieldLabel>
        <FieldControl
          render={
            <Input
              name={field.path}
              onBlur={handleBlur}
              onChange={(e) => onChange(field.path, e.target.value)}
              placeholder={field.hint}
              type="number"
              value={typeof value === "string" ? value : ""}
            />
          }
        />
        <FieldError message={error} />
      </Field>
    );
  }

  if (inputType === "date") {
    return (
      <Field>
        <FieldLabel>
          {label}
          {required && <RequiredIndicator />}
          <PrefillBadge snippet={prefillSnippet} />
        </FieldLabel>
        <DatePickerPopover
          locale={locale}
          onChange={(v) => onChange(field.path, v ?? "")}
          value={typeof value === "string" ? value : ""}
        />
        <DateQuickChips
          onPick={(iso) => {
            onChange(field.path, iso);
            onBlur?.(field.path);
          }}
        />
        <DateRenderPreview dateFormat={field.dateFormat} value={value} />
        <FieldError message={error} />
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel>
        {label}
        {required && <RequiredIndicator />}
        <PrefillBadge snippet={prefillSnippet} />
      </FieldLabel>
      <FieldControl
        render={
          <Input
            name={field.path}
            onBlur={handleBlur}
            onChange={(e) => onChange(field.path, e.target.value)}
            placeholder={field.hint}
            type="text"
            value={typeof value === "string" ? value : ""}
          />
        }
      />
      <AiAdaptHint show={field.aiAdapt === true} />
      <LookupHint lookup={field.lookup} />
      <FieldError message={error} />
    </Field>
  );
};

const ArrayFieldRenderer = ({
  field,
  values,
  onChange,
  onBlur,
  onClearPaths,
  errors,
  touched,
}: {
  field: ResolvedField;
  values: FormValues;
  onChange: (path: string, value?: unknown) => void;
  onBlur: (path: string) => void;
  onClearPaths: (paths: string[]) => void;
  errors: FieldErrors;
  touched: TouchedFields;
}) => {
  const t = useTranslations();
  const itemFields: ResolvedField[] = field.itemFields ?? [];
  const arrayKey = arrayIndexKey(field.path);
  const items = readArrayIndices(values, arrayKey);
  const maxItems = field.validation?.maxItems;
  const atMax = maxItems !== undefined && items.length >= maxItems;

  const addItem = () => {
    if (atMax) {
      return;
    }
    const nextIndex = items.length;
    const newItems = [...items, nextIndex];
    onChange(arrayKey, newItems);

    for (const subField of itemFields) {
      const itemPath = `${field.path}[${nextIndex}].${subField.path}`;
      onChange(itemPath, getDefaultValue(subField));
    }
  };

  const removeItem = (index: number) => {
    const newItems: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (i === index) {
        continue;
      }
      newItems.push(newItems.length);
    }
    onChange(arrayKey, newItems);

    const updated: FormValues = {};
    let newIdx = 0;
    for (let i = 0; i < items.length; i++) {
      if (i === index) {
        continue;
      }
      for (const subField of itemFields) {
        const oldPath = `${field.path}[${i}].${subField.path}`;
        const newPath = `${field.path}[${newIdx}].${subField.path}`;
        updated[newPath] = values[oldPath];
      }
      newIdx++;
    }

    const stalePaths: string[] = [];
    for (const subField of itemFields) {
      const trailingPath = `${field.path}[${items.length - 1}].${subField.path}`;
      onChange(trailingPath);
      stalePaths.push(trailingPath);
    }
    onClearPaths(stalePaths);

    for (const [path, val] of Object.entries(updated)) {
      onChange(path, val);
    }
  };

  const label = field.label ?? field.path;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-2">
          {maxItems !== undefined && (
            <span className="text-muted-foreground text-xs">
              {t("templates.upToNItems", { max: String(maxItems) })}
            </span>
          )}
          <Button
            disabled={atMax}
            onClick={addItem}
            size="sm"
            variant="outline"
          >
            <PlusIcon />
            {t("templates.addItem")}
          </Button>
        </div>
      </div>
      <FieldError
        message={touched[field.path] ? errors[field.path] : undefined}
      />

      {items.map((_, index) => (
        <div
          className="relative flex flex-col gap-3 rounded-lg border p-4"
          key={`${field.path}-${String(index)}`}
        >
          <Button
            className="absolute end-2 top-2"
            onClick={() => removeItem(index)}
            size="icon-xs"
            variant="ghost"
          >
            <TrashIcon />
          </Button>

          {itemFields.map((subField) => {
            const itemPath = `${field.path}[${index}].${subField.path}`;
            return (
              <FieldRenderer
                error={touched[itemPath] ? errors[itemPath] : undefined}
                field={{
                  ...subField,
                  path: itemPath,
                }}
                key={itemPath}
                onBlur={onBlur}
                onChange={onChange}
                value={values[itemPath]}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
};

const buildSubmitValues = (
  values: FormValues,
  fields: ResolvedField[],
  conditions: NamedCondition[],
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    // Skip hidden fields
    if (!isFieldVisible(field, values, conditions)) {
      continue;
    }

    if (field.kind === "array") {
      const arrayKey = arrayIndexKey(field.path);
      const items = readArrayIndices(values, arrayKey);
      const itemFields: ResolvedField[] = field.itemFields ?? [];
      const arrayValues: Record<string, unknown>[] = [];

      for (let i = 0; i < items.length; i++) {
        const itemObj: Record<string, unknown> = {};
        for (const subField of itemFields) {
          const path = `${field.path}[${i}].${subField.path}`;
          const val = values[path];
          if (val !== undefined && val !== "") {
            itemObj[subField.path] = coerceValue(subField, val);
          }
        }
        arrayValues.push(itemObj);
      }

      result[field.path] = arrayValues;
      continue;
    }

    const parts = compositeParts(field);
    if (parts) {
      const partValues = readPartValues(values[field.path]);
      const anyFilled = parts.some(
        (part) => (partValues[part.key] ?? "").trim() !== "",
      );
      if (anyFilled) {
        // Submit every part key (validation guarantees all are filled); the
        // server assembles them via the field's format.
        const submitParts: Record<string, string> = {};
        for (const part of parts) {
          submitParts[part.key] = partValues[part.key] ?? "";
        }
        setNestedValue(result, field.path, submitParts);
      }
      continue;
    }

    const val = values[field.path];
    if (val !== undefined && val !== "") {
      setNestedValue(result, field.path, coerceValue(field, val));
    }
  }

  return result;
};

const coerceValue = (field: ResolvedField, value: unknown): unknown => {
  if (field.kind === "boolean") {
    return value === true;
  }
  if (field.inputType === "number" && typeof value === "string") {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }
  return value;
};

const setNestedValue = (
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
) => {
  const parts = path.split(".");
  const last = parts.at(-1);
  if (!last) {
    return;
  }
  let current = obj;

  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      // SAFETY: a plain object value is structurally compatible with
      // Record<string, unknown>; we guarded against arrays/null above.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      current = next as Record<string, unknown>;
      continue;
    }
    const child: Record<string, unknown> = {};
    current[part] = child;
    current = child;
  }

  current[last] = value;
};

/** Collect all validatable fields, including array
 *  sub-fields expanded for each item. Hidden fields
 *  are excluded so they don't block validation. */
const collectValidatableFields = (
  fields: ResolvedField[],
  values: FormValues,
  conditions: NamedCondition[],
): { path: string; field: ResolvedField }[] => {
  const result: { path: string; field: ResolvedField }[] = [];

  for (const field of fields) {
    // Skip hidden fields
    if (!isFieldVisible(field, values, conditions)) {
      continue;
    }

    if (field.kind === "array") {
      const arrayKey = arrayIndexKey(field.path);
      const items = readArrayIndices(values, arrayKey);
      const itemFields: ResolvedField[] = field.itemFields ?? [];

      for (let i = 0; i < items.length; i++) {
        for (const sub of itemFields) {
          const itemPath = `${field.path}[${i}].${sub.path}`;
          result.push({ path: itemPath, field: sub });
        }
      }
      continue;
    }

    result.push({ path: field.path, field });
  }

  return result;
};

/** Every way the user can submit the fill form; the empty-fields gate is
 *  armed per action so confirming one does not confirm the others. */
type SubmitAction =
  | "downloadDocx"
  | "downloadPdf"
  | "createDocument"
  | "moveToMatter";

/** Whether the user left this field without a value. Booleans never count
 *  as empty: unchecked is a deliberate "no", not a gap. */
const isFieldValueEmpty = (field: ResolvedField, value: unknown): boolean => {
  if (field.kind === "boolean" || field.inputType === "boolean") {
    return false;
  }
  const parts = compositeParts(field);
  if (parts) {
    const partValues = readPartValues(value);
    return parts.every((part) => (partValues[part.key] ?? "").trim() === "");
  }
  return typeof value !== "string" || value.trim() === "";
};

const isFieldRequired = (field: ResolvedField): boolean =>
  field.required ?? field.validation?.required ?? false;

/** Report an array field's empty optional entries to `push`: the array
 *  itself when it has no items, else each item's empty optional sub-fields. */
const collectEmptyArrayFields = (
  field: ResolvedField,
  values: FormValues,
  push: (field: ResolvedField) => void,
) => {
  const items = readArrayIndices(values, arrayIndexKey(field.path));
  if (items.length === 0) {
    if (!isFieldRequired(field)) {
      push(field);
    }
    return;
  }
  for (let i = 0; i < items.length; i++) {
    for (const sub of field.itemFields ?? []) {
      if (isFieldRequired(sub)) {
        continue;
      }
      const itemPath = `${field.path}[${i}].${sub.path}`;
      if (isFieldValueEmpty(sub, values[itemPath])) {
        push(sub);
      }
    }
  }
};

/** Labels of visible optional fields the user left empty (an array with no
 *  items counts once under its own label). Required empties never reach
 *  this soft gate: hard validation blocks them first. The caller already
 *  excludes derived (formula / AI-drafted) fields from `fields`. */
const collectEmptyOptionalFields = (
  fields: readonly ResolvedField[],
  values: FormValues,
  conditions: readonly NamedCondition[],
): string[] => {
  const labels: string[] = [];
  const push = (field: ResolvedField) => {
    const label = field.label ?? field.path;
    if (!labels.includes(label)) {
      labels.push(label);
    }
  };

  for (const field of fields) {
    if (!isFieldVisible(field, values, conditions)) {
      continue;
    }
    if (field.kind === "array") {
      collectEmptyArrayFields(field, values, push);
      continue;
    }
    if (
      !isFieldRequired(field) &&
      isFieldValueEmpty(field, values[field.path])
    ) {
      push(field);
    }
  }
  return labels;
};

// Registries offered for one-click party-block autofill. Slugs are a
// subset of the unified lookup endpoint's supported registries; labels
// are registry proper names (not translatable UI copy).
const REGISTRY_OPTIONS = [
  { slug: "krs", label: "Poland — KRS" },
  { slug: "ares", label: "Czechia — ARES" },
  { slug: "orsr", label: "Slovakia — ORSR" },
  { slug: "companies-house", label: "United Kingdom — Companies House" },
  { slug: "prh", label: "Finland — PRH" },
  { slug: "brreg", label: "Norway — Brønnøysund" },
  { slug: "recherche-entreprises", label: "France — recherche-entreprises" },
] as const;

type RegistrySlug = (typeof REGISTRY_OPTIONS)[number]["slug"];

/** One-click party-block autofill from a business register. Looks up a
 *  company by its canonical id (KRS number, IČO, …) and fills the
 *  matching fields in this group; the user reviews before submitting. */
const RegistryAutofillControl = ({
  groupFields,
  onApply,
}: {
  groupFields: ResolvedField[];
  onApply: (updates: { path: string; value: string }[]) => void;
}) => {
  const t = useTranslations();
  const [registry, setRegistry] = useState<RegistrySlug>("krs");
  const [companyId, setCompanyId] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLookup = async () => {
    const q = companyId.trim();
    if (q === "") {
      return;
    }
    setLoading(true);
    const response = await api.contacts["business-registries"].get({
      query: { registry, q },
    });
    setLoading(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.registryNotFound"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    const { data } = response;
    if (data instanceof Response || data.type !== "lookup" || !data.hit) {
      stellaToast.add({
        type: "error",
        title: t("templates.registryNotFound"),
      });
      return;
    }

    const updates = buildAutofillUpdates(groupFields, data.hit);
    if (updates.length === 0) {
      stellaToast.add({
        type: "error",
        title: t("templates.registryNotFound"),
      });
      return;
    }
    onApply(updates);
    stellaToast.add({
      type: "success",
      title: t("templates.registryFilled", { count: updates.length }),
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b pb-3">
      <Select
        onValueChange={(val) => {
          const option = REGISTRY_OPTIONS.find((o) => o.slug === val);
          if (option) {
            setRegistry(option.slug);
          }
        }}
        value={registry}
      >
        <SelectTrigger className="w-auto min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {REGISTRY_OPTIONS.map((option) => (
            <SelectItem key={option.slug} value={option.slug}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Input
        className="w-44"
        onChange={(e) => setCompanyId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void handleLookup();
          }
        }}
        placeholder={t("templates.registryIdPlaceholder")}
        value={companyId}
      />
      <Button
        disabled={loading || companyId.trim() === ""}
        onClick={() => void handleLookup()}
        type="button"
        variant="outline"
      >
        {t("templates.registryLookup")}
      </Button>
    </div>
  );
};

export const TemplateForm = ({
  fields: allFields,
  conditions,
  structureErrors,
  file,
  templateId,
  fileName,
  onBack,
  onDone,
  onValuesChange,
  saveTarget,
  prefill,
}: TemplateFormProps) => {
  const t = useTranslations();
  // Formula fields are derived server-side at fill time, never user-entered:
  // the form renders no input for them and submits no value.
  // Derived fields never render as inputs: formulas compute from other
  // values, and AI-drafted fields (aiPrompt) are written by the model at
  // fill time. Fields whose marker appears nowhere (count 0) are asked only
  // when something still consumes the answer: condition questions
  // (booleans), paths referenced by a named condition, or sources another
  // field derives from (formula, optionsFrom).
  const referencedPaths = new Set<string>();
  for (const condition of conditions) {
    for (const f of allFields) {
      if (condition.expression.includes(f.path)) {
        referencedPaths.add(f.path);
      }
    }
  }
  for (const f of allFields) {
    if (f.optionsFrom !== undefined) {
      referencedPaths.add(f.optionsFrom);
    }
    if (f.formula !== undefined) {
      for (const other of allFields) {
        if (f.formula.includes(other.path)) {
          referencedPaths.add(other.path);
        }
      }
    }
  }
  const fields = allFields.filter(
    (f) =>
      f.formula === undefined &&
      f.aiPrompt === undefined &&
      f.condition === undefined &&
      (f.count > 0 || f.inputType === "boolean" || referencedPaths.has(f.path)),
  );
  const [values, setValues] = useState<FormValues>(() =>
    buildInitialValues(fields),
  );
  useEffect(() => {
    onValuesChange?.(values);
  }, [values, onValuesChange]);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState<TouchedFields>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  // Source snippets for AI-prefilled fields, keyed by field path. Presence
  // drives the wand badge; entries are dropped when the user clears the
  // value. Null means "prefilled, but the model gave no snippet".
  const [prefillSnippets, setPrefillSnippets] = useState<
    Record<string, string | null>
  >({});
  const touchedRef = useRef(touched);
  touchedRef.current = touched;
  const valuesRef = useRef(values);
  valuesRef.current = values;

  /** Resolve a ValidationError to a translated string. */
  const resolveError = useCallback(
    (err: ValidationError | undefined): string | undefined => {
      if (!err) {
        return undefined;
      }
      switch (err.kind) {
        case "required":
          return t("templates.validationRequired");
        case "minLength":
          return t("templates.validationMinLength", {
            min: String(err.min),
          });
        case "maxLength":
          return t("templates.validationMaxLength", {
            max: String(err.max),
          });
        case "numberMin":
          return t("templates.validationNumberMin", {
            min: String(err.min),
          });
        case "numberMax":
          return t("templates.validationNumberMax", {
            max: String(err.max),
          });
        case "pattern":
          return t("templates.validationPattern");
        case "optionNotInSource":
          return t("templates.validationOptionNotInSource", {
            field: err.source,
          });
        case "lookupNumber":
          return t("templates.validationKrsFormat");
        case "minItems":
          return t("templates.validationMinItems", {
            min: String(err.min),
          });
        default:
          return undefined;
      }
    },
    [t],
  );

  /** Find the ResolvedField definition for a given
   *  path (handles array sub-fields). */
  const findFieldDef = useCallback(
    (path: string): ResolvedField | undefined => {
      for (const f of fields) {
        if (f.path === path) {
          return f;
        }
        if (f.kind === "array" && f.itemFields) {
          for (const sub of f.itemFields) {
            // Array item paths: "arr[0].sub"
            if (
              path.startsWith(`${f.path}[`) &&
              path.endsWith(`.${sub.path}`)
            ) {
              return sub;
            }
          }
        }
      }
      return undefined;
    },
    [fields],
  );

  const handleChange = useCallback((path: string, value: unknown) => {
    valuesRef.current = { ...valuesRef.current, [path]: value };
    setValues((prev) => ({ ...prev, [path]: value }));
  }, []);

  /** Drop a field's prefill badge once its value is cleared (empty string,
   *  unchecked boolean, or every composite part blank). Edits keep it. */
  const clearPrefillSnippetIfEmptied = useCallback(
    (path: string, value: unknown) => {
      const isEmpty =
        value === "" ||
        value === false ||
        value === undefined ||
        (typeof value === "object" &&
          value !== null &&
          Object.values(readPartValues(value)).every(
            (part) => part.trim() === "",
          ));
      if (!isEmpty) {
        return;
      }
      setPrefillSnippets((prev) => {
        if (!(path in prev)) {
          return prev;
        }
        const { [path]: _, ...rest } = prev;
        return rest;
      });
    },
    [],
  );

  /** Re-validate on change when the field was already
   *  touched. Uses a ref so the touched check is never
   *  stale between blur and the next render. */
  const handleChangeWithValidation = useCallback(
    (path: string, value: unknown) => {
      handleChange(path, value);
      clearPrefillSnippetIfEmptied(path, value);

      // Only re-validate if already touched
      if (!touchedRef.current[path]) {
        return;
      }
      const def = findFieldDef(path);
      if (def) {
        const msg = resolveError(validateField(def, value));
        setErrors((prev) => {
          if (prev[path] === msg) {
            return prev;
          }
          return { ...prev, [path]: msg };
        });
      }
    },
    [handleChange, clearPrefillSnippetIfEmptied, findFieldDef, resolveError],
  );

  const handleBlur = useCallback(
    (path: string) => {
      setTouched((prev) => {
        if (prev[path]) {
          return prev;
        }
        return { ...prev, [path]: true };
      });
      touchedRef.current[path] = true;
      const def = findFieldDef(path);
      if (def) {
        const msg = resolveError(validateField(def, valuesRef.current[path]));
        setErrors((prev) => {
          if (prev[path] === msg) {
            return prev;
          }
          return { ...prev, [path]: msg };
        });
      }
    },
    [findFieldDef, resolveError],
  );

  /** Remove stale error/touched entries for paths
   *  that no longer correspond to form fields (e.g.
   *  after an array item is removed). */
  const handleClearPaths = useCallback((paths: string[]) => {
    setErrors((prev) => {
      let next = { ...prev };
      for (const p of paths) {
        const { [p]: _, ...rest } = next;
        next = rest;
      }
      return next;
    });
    setTouched((prev) => {
      let next = { ...prev };
      for (const p of paths) {
        const { [p]: _, ...rest } = next;
        next = rest;
      }
      return next;
    });
    for (const p of paths) {
      const { [p]: _, ...rest } = touchedRef.current;
      touchedRef.current = rest;
    }
  }, []);

  /** Apply registry-autofill updates to the form. */
  const applyAutofill = useCallback(
    (updates: { path: string; value: string }[]) => {
      for (const update of updates) {
        handleChangeWithValidation(update.path, update.value);
      }
    },
    [handleChangeWithValidation],
  );

  /** Apply AI prefill proposals to the form: set values, remember the
   *  supporting snippets for the wand badges, and report how many landed.
   *  Everything stays freely editable; nothing is submitted. */
  const applyPrefill = (suggestions: PrefillSuggestionDto[]): number => {
    let applied = 0;
    const nextSnippets: Record<string, string | null> = {};

    for (const suggestion of suggestions) {
      const def = fields.find((f) => f.path === suggestion.path);
      if (!def || def.kind === "array") {
        continue;
      }
      const parts = compositeParts(def);

      if (suggestion.partKey !== null) {
        if (!parts || !parts.some((part) => part.key === suggestion.partKey)) {
          continue;
        }
        const current = readPartValues(valuesRef.current[suggestion.path]);
        handleChangeWithValidation(suggestion.path, {
          ...current,
          [suggestion.partKey]: suggestion.value,
        });
      } else if (parts) {
        // A composite field only accepts per-part proposals.
        continue;
      } else if (def.kind === "boolean" || def.inputType === "boolean") {
        handleChangeWithValidation(
          suggestion.path,
          suggestion.value === "true",
        );
      } else {
        handleChangeWithValidation(suggestion.path, suggestion.value);
      }

      if (
        !(suggestion.path in nextSnippets) ||
        suggestion.sourceSnippet !== null
      ) {
        nextSnippets[suggestion.path] = suggestion.sourceSnippet;
      }
      applied++;
    }

    if (applied > 0) {
      setPrefillSnippets((prev) => ({ ...prev, ...nextSnippets }));
    }
    return applied;
  };

  /** Validate all fields; returns true if valid. */
  const validateAll = useCallback(
    (currentValues: FormValues): boolean => {
      const all = collectValidatableFields(fields, currentValues, conditions);
      const nextErrors: FieldErrors = {};
      const nextTouched: TouchedFields = {};
      let valid = true;

      for (const { path, field } of all) {
        nextTouched[path] = true;
        const msg = resolveError(
          validateField(field, currentValues[path]) ??
            validateDependentSelection(
              field,
              currentValues[path],
              fields,
              currentValues,
            ),
        );
        nextErrors[path] = msg;
        if (msg) {
          valid = false;
        }
      }

      // Loop minimum-repeats: an array below its minItems blocks submit. The
      // maxItems cap is enforced live by disabling "Add item", so only the
      // lower bound needs a submit-time check. Keyed on the container path so
      // the ArrayFieldRenderer surfaces it.
      for (const field of fields) {
        if (field.kind !== "array") {
          continue;
        }
        if (!isFieldVisible(field, currentValues, conditions)) {
          continue;
        }
        const min = field.validation?.minItems;
        if (min === undefined || min <= 0) {
          continue;
        }
        const count = readArrayIndices(
          currentValues,
          arrayIndexKey(field.path),
        ).length;
        if (count < min) {
          nextTouched[field.path] = true;
          nextErrors[field.path] = resolveError({ kind: "minItems", min });
          valid = false;
        }
      }

      setTouched((prev) => ({ ...prev, ...nextTouched }));
      setErrors(nextErrors);
      return valid;
    },
    [fields, conditions, resolveError],
  );

  // Soft empty-fields gate: the warning shown in the action row after the
  // first attempt of an action while optional fields are still empty.
  const [emptyWarning, setEmptyWarning] = useState<{
    action: SubmitAction;
    count: number;
    names: string;
  } | null>(null);
  const emptyWarningRef = useRef(emptyWarning);
  emptyWarningRef.current = emptyWarning;

  /** Gate every submit path: with optional fields still empty, the first
   *  attempt arms the warning and aborts; repeating the same action (its
   *  button now reads "… anyway") proceeds. Returns true to proceed. */
  const confirmEmptyFields = useCallback(
    (action: SubmitAction, currentValues: FormValues): boolean => {
      const empty = collectEmptyOptionalFields(
        fields,
        currentValues,
        conditions,
      );
      if (empty.length === 0 || emptyWarningRef.current?.action === action) {
        setEmptyWarning(null);
        return true;
      }
      const shown = empty.slice(0, 3).join(", ");
      setEmptyWarning({
        action,
        count: empty.length,
        names: empty.length > 3 ? `${shown}…` : shown,
      });
      return false;
    },
    [fields, conditions],
  );

  // Only count errors for currently visible fields;
  // hidden fields may retain stale errors in state.
  const hasErrors = Object.entries(errors).some(([path, msg]) => {
    if (!msg) {
      return false;
    }
    const def = findFieldDef(path);
    if (!def) {
      return true;
    }
    // Find the top-level field to check visibility
    const topField = fields.find(
      (f) =>
        f.path === path ||
        (f.kind === "array" && path.startsWith(`${f.path}[`)),
    );
    if (topField && !isFieldVisible(topField, values, conditions)) {
      return false;
    }
    return true;
  });

  const handleDownload = useCallback(
    async (format: FillFormat) => {
      if (!validateAll(values)) {
        // Scroll to the first errored field
        const all = collectValidatableFields(fields, values, conditions);
        for (const { path, field: f } of all) {
          const msg = resolveError(
            validateField(f, values[path]) ??
              validateDependentSelection(f, values[path], fields, values),
          );
          if (msg) {
            const el = document.querySelector(`[name="${CSS.escape(path)}"]`);
            el?.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
            break;
          }
        }
        stellaToast.add({
          type: "error",
          title: t("templates.validationErrors"),
        });
        return;
      }

      const action: SubmitAction =
        format === "pdf" ? "downloadPdf" : "downloadDocx";
      if (!confirmEmptyFields(action, values)) {
        return;
      }

      setLoading(true);

      const submitValues = buildSubmitValues(values, fields, conditions);
      const valuesJson = JSON.stringify(submitValues);

      const fillResponse = async () => {
        if (templateId) {
          return await api
            .templates({ templateId })
            .fill.post({ values: valuesJson }, { query: { format } });
        }
        if (!file) {
          panic(
            "TemplateForm: transient fill requires a file when templateId is absent",
          );
        }
        return await api.templates.fill.post(
          { file, values: valuesJson },
          { query: { format } },
        );
      };
      const response = await fillResponse();

      setLoading(false);

      if (response.error) {
        const errorKey =
          format === "pdf"
            ? "templates.pdfConversionFailed"
            : "templates.fillFailed";
        stellaToast.add({
          type: "error",
          title: t(errorKey),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }

      const data = response.data;
      const mimeType = format === "pdf" ? PDF_MIME : DOCX_MIME;
      const blob =
        data instanceof Response
          ? await data.blob()
          : // SAFETY: Eden returns a typed object for the fill
            // endpoint, but the actual response is binary
            // data; the double cast bridges the type mismatch.
            // eslint-disable-next-line typescript/no-unsafe-type-assertion
            new Blob([data as unknown as BlobPart], {
              type: mimeType,
            });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      // SAFETY: the discriminated union guarantees `file` is
      // defined when `fileName` (from server-side path) is absent.
      const baseName = fileName ?? file.name;
      const filename =
        format === "pdf"
          ? `filled-${DOCX_EXT_RE.test(baseName) ? baseName.replace(DOCX_EXT_RE, ".pdf") : `${baseName}.pdf`}`
          : `filled-${baseName}`;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);

      onDone(filename);
    },
    [
      values,
      fields,
      conditions,
      file,
      templateId,
      fileName,
      t,
      onDone,
      validateAll,
      confirmEmptyFields,
      resolveError,
    ],
  );

  // ── Save to matter ────────────────────────────────
  const [matterDialogOpen, setMatterDialogOpen] = useState(false);
  const [matterTarget, setMatterTarget] = useState<MatterTarget | null>(null);

  /** Fill server-side and persist the result as a document entity in the
   *  given matter (the fill-to endpoint). Validates like a download. */
  const fillToMatter = async (workspaceId: string, parentId: string | null) => {
    if (!templateId || !saveTarget) {
      return;
    }
    if (!validateAll(values)) {
      stellaToast.add({
        type: "error",
        title: t("templates.validationErrors"),
      });
      return;
    }

    setLoading(true);
    const submitValues = buildSubmitValues(values, fields, conditions);
    const response = await api
      .templates({ templateId })
      ["fill-to"]({ workspaceId })
      .post({
        values: JSON.stringify(submitValues),
        ...(parentId !== null && { parentId: toSafeId<"entity">(parentId) }),
      });
    setLoading(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.fillFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    const created = response.data;
    stellaToast.add({
      type: "success",
      title: t("success.documentCreated"),
    });
    if (created.unmatchedPlaceholders.length > 0) {
      stellaToast.add({
        type: "warning",
        title: t("templates.unmatchedPlaceholders", {
          list: created.unmatchedPlaceholders.join(", "),
        }),
      });
    }

    setMatterDialogOpen(false);
    if (saveTarget.kind === "matter") {
      saveTarget.onCreated(created.entityId);
    } else {
      saveTarget.onCreated({ workspaceId, entityId: created.entityId });
    }
    onDone(created.fileName);
  };

  /** "Move to matter": validate first so the picker only opens over a
   *  submittable form. */
  const handleChooseMatter = () => {
    if (!validateAll(values)) {
      stellaToast.add({
        type: "error",
        title: t("templates.validationErrors"),
      });
      return;
    }
    if (!confirmEmptyFields("moveToMatter", values)) {
      return;
    }
    setMatterTarget(null);
    setMatterDialogOpen(true);
  };

  const handleSubmit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saveTarget?.kind === "matter") {
      // Validate + gate here so the empty-fields warning can interpose
      // before fillToMatter fires (it re-validates internally).
      if (!validateAll(values)) {
        stellaToast.add({
          type: "error",
          title: t("templates.validationErrors"),
        });
        return;
      }
      if (!confirmEmptyFields("createDocument", values)) {
        return;
      }
      void fillToMatter(saveTarget.workspaceId, saveTarget.parentId ?? null);
      return;
    }
    // Errors are surfaced as toasts inside handleDownload
    // TODO: fix this
    // oxlint-disable-next-line no-empty-function
    handleDownload("docx").catch(() => {});
  };

  // Filter visible non-array fields, then group
  const visibleScalarFields = fields.filter(
    (f) => f.kind !== "array" && isFieldVisible(f, values, conditions),
  );
  const grouped = groupFieldsByPrefix(visibleScalarFields);
  const arrayFields = fields.filter(
    (f) => f.kind === "array" && isFieldVisible(f, values, conditions),
  );

  const submitAction: SubmitAction =
    saveTarget?.kind === "matter" ? "createDocument" : "downloadDocx";

  /** Action-row label: the busy label while generating, the "… anyway"
   *  confirm variant while the empty-fields warning targets this action. */
  const actionButtonLabel = (action: SubmitAction): string => {
    if (loading && action !== "moveToMatter") {
      return t("templates.generating");
    }
    if (emptyWarning?.action === action) {
      if (action === "createDocument") {
        return t("templates.createDocumentAnyway");
      }
      if (action === "moveToMatter") {
        return t("templates.moveToMatterAnyway");
      }
      return t("templates.downloadAnyway");
    }
    if (action === "downloadPdf") {
      return t("templates.downloadPdf");
    }
    if (action === "downloadDocx") {
      return t("templates.downloadDocx");
    }
    if (action === "createDocument") {
      return t("templates.createDocument");
    }
    return t("templates.moveToMatter");
  };

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl p-6">
          {/* Transient (upload) fill shows the form header + "upload different";
            server-side fill is embedded in the Studio's Fill tab, which labels
            itself, so the header would be redundant chrome. */}
          {file !== undefined && (
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {t("templates.fillForm")}
              </h2>
              <Button onClick={onBack} variant="ghost">
                {t("templates.uploadDifferent")}
              </Button>
            </div>
          )}

          {structureErrors.length > 0 && (
            <div className="border-warning/30 bg-warning/10 dark:bg-warning/10 mb-6 flex items-start gap-2 rounded-lg border p-3">
              <AlertTriangleIcon className="text-warning-foreground mt-0.5 size-4 shrink-0" />
              <span className="text-warning-foreground text-sm">
                {t("templates.structureWarnings", {
                  count: structureErrors.length,
                })}
              </span>
            </div>
          )}

          <div className="flex flex-col gap-5">
            {prefill !== undefined && templateId !== undefined && (
              <TemplatePrefillPanel
                matterWorkspaceId={prefill.workspaceId}
                onApply={applyPrefill}
                templateId={templateId}
              />
            )}

            {[...grouped.entries()].map(([prefix, groupFields]) => (
              <fieldset
                className={cn(
                  "flex flex-col gap-4",
                  prefix !== "" && "rounded-lg border p-4",
                )}
                key={prefix || "__root"}
              >
                {prefix !== "" && (
                  <legend className="text-muted-foreground px-1 text-sm font-medium">
                    {prefix}
                  </legend>
                )}
                {prefix !== "" &&
                  groupSupportsRegistryAutofill(groupFields) && (
                    <RegistryAutofillControl
                      groupFields={groupFields}
                      onApply={applyAutofill}
                    />
                  )}
                {groupFields.map((field) => (
                  <FieldRenderer
                    derivedOptions={
                      dependentOptions(field, fields, values) ?? undefined
                    }
                    error={touched[field.path] ? errors[field.path] : undefined}
                    field={field}
                    key={field.path}
                    onBlur={handleBlur}
                    onChange={handleChangeWithValidation}
                    prefillSnippet={prefillSnippets[field.path]}
                    value={values[field.path]}
                  />
                ))}
              </fieldset>
            ))}

            {arrayFields.map((field) => (
              <ArrayFieldRenderer
                errors={errors}
                field={field}
                key={field.path}
                onBlur={handleBlur}
                onChange={handleChangeWithValidation}
                onClearPaths={handleClearPaths}
                touched={touched}
                values={values}
              />
            ))}
          </div>
        </div>
      </div>

      {emptyWarning !== null && (
        <div className="border-warning/30 bg-warning/10 dark:bg-warning/10 flex shrink-0 items-start gap-2 border-t px-3 py-2">
          <AlertTriangleIcon className="text-warning-foreground mt-0.5 size-4 shrink-0" />
          <span className="text-warning-foreground text-sm">
            {t("templates.emptyFieldsWarning", {
              count: emptyWarning.count,
              names: emptyWarning.names,
            })}
          </span>
        </div>
      )}

      {/* Pinned action row, styled like the Studio's other chrome rows. */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 border-t px-2",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        {saveTarget?.kind !== "matter" && (
          <Button
            disabled={loading || hasErrors}
            onClick={() => {
              void handleDownload("pdf").catch(() => undefined);
            }}
            type="button"
            variant="outline"
          >
            {actionButtonLabel("downloadPdf")}
          </Button>
        )}
        {saveTarget?.kind === "chooseMatter" && (
          <Button
            disabled={loading || hasErrors}
            onClick={handleChooseMatter}
            type="button"
            variant="outline"
          >
            {actionButtonLabel("moveToMatter")}
          </Button>
        )}
        <Button disabled={loading || hasErrors} type="submit">
          {actionButtonLabel(submitAction)}
        </Button>
      </div>

      {/* "Move to matter" target picker; the popup portals out of the form,
          so its buttons cannot implicitly submit it. */}
      <Dialog onOpenChange={setMatterDialogOpen} open={matterDialogOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("templates.moveToMatter")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <MatterTargetPicker
              onChange={setMatterTarget}
              value={matterTarget}
            />
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setMatterDialogOpen(false)} variant="ghost">
              {t("common.cancel")}
            </Button>
            <Button
              disabled={matterTarget === null || loading}
              onClick={() => {
                if (matterTarget !== null) {
                  void fillToMatter(
                    matterTarget.workspaceId,
                    matterTarget.parentId,
                  );
                }
              }}
            >
              {loading
                ? t("templates.generating")
                : t("templates.createDocument")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </form>
  );
};

/**
 * A `chooseMatter` {@link SaveTarget} whose `onCreated` opens the filled DOCX
 * in the editable Folio editor: it invalidates the destination matter's entity
 * list, then navigates to the entities route, which resolves the document's
 * file field and redirects into the document view. Reused by every "fill into
 * a matter the user picks" surface (the Knowledge "Use template" dialog and the
 * Template Studio Fill facet) so the post-fill behaviour stays identical.
 *
 * `onDone` runs after the entity is created and navigation is kicked off (the
 * Studio facet has no use for it; the dialog uses it to close itself).
 */
export const useFillToMatterSaveTarget = (
  onDone?: () => void,
): Extract<SaveTarget, { kind: "chooseMatter" }> => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return {
    kind: "chooseMatter",
    onCreated: ({ workspaceId, entityId }) => {
      queryClient
        .invalidateQueries({ queryKey: entitiesKeys.all(workspaceId) })
        .catch(() => {
          /* fire-and-forget */
        });
      onDone?.();
      navigate({
        to: "/workspaces/$workspaceId/entities/$entityId",
        params: { workspaceId, entityId },
      }).catch(() => {
        /* navigation is best-effort; the document is already saved */
      });
    },
  };
};
