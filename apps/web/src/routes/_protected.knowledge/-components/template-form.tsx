import { useEffect, useCallback, useRef, useState } from "react";

import { panic } from "better-result";
import {
  AlertTriangleIcon,
  EyeIcon,
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
  DialogClose,
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
import { api } from "@/lib/api";
import { DOCX_MIME, PDF_MIME } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors";

import {
  buildAutofillUpdates,
  groupSupportsRegistryAutofill,
} from "./registry-autofill";

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

type FieldErrors = Record<string, string | undefined>;
type TouchedFields = Record<string, boolean>;

type ValidationError =
  | { kind: "required" }
  | { kind: "minLength"; min: number }
  | { kind: "maxLength"; max: number }
  | { kind: "numberMin"; min: number }
  | { kind: "numberMax"; max: number }
  | { kind: "pattern" };

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

type TemplateFormProps = (TransientFillProps | ServerFillProps) & {
  /** Live values tap for hosts that preview the fill elsewhere. */
  onValuesChange?: (values: Record<string, unknown>) => void;
};

type FormValues = Record<string, unknown>;

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
}: {
  field: ResolvedField;
  parts: CompositePart[];
  label: string;
  required: boolean;
  value: unknown;
  onChange: (path: string, value?: unknown) => void;
  onBlur?: ((path: string) => void) | undefined;
  error?: string | undefined;
}) => {
  const partValues = readPartValues(value);
  const setPart = (key: string, partValue: string) =>
    onChange(field.path, { ...partValues, [key]: partValue });

  return (
    <Field>
      <FieldLabel>
        {label}
        {required && <RequiredIndicator />}
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
}: {
  field: ResolvedField;
  value: unknown;
  onChange: (path: string, value?: unknown) => void;
  onBlur?: ((path: string) => void) | undefined;
  error?: string | undefined;
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
          </FieldLabel>
        </div>
        <FieldError message={error} />
      </Field>
    );
  }

  if (inputType === "select" && field.options && field.options.length > 0) {
    return (
      <Field>
        <FieldLabel>
          {label}
          {required && <RequiredIndicator />}
        </FieldLabel>
        <Select
          name={field.path}
          onValueChange={(val) => {
            onChange(field.path, val);
            onBlur?.(field.path);
          }}
          value={value === "" || typeof value !== "string" ? undefined : value}
        >
          <SelectTrigger>
            <SelectValue placeholder={label} />
          </SelectTrigger>
          <SelectPopup>
            {field.options.map((option: string) => (
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
        </FieldLabel>
        <FieldControl
          render={
            <Textarea
              name={field.path}
              onBlur={handleBlur}
              onChange={(e) => onChange(field.path, e.target.value)}
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
        </FieldLabel>
        <FieldControl
          render={
            <Input
              name={field.path}
              onBlur={handleBlur}
              onChange={(e) => onChange(field.path, e.target.value)}
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
        </FieldLabel>
        <DatePickerPopover
          locale={locale}
          onChange={(v) => onChange(field.path, v ?? "")}
          value={typeof value === "string" ? value : ""}
        />
        <FieldError message={error} />
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel>
        {label}
        {required && <RequiredIndicator />}
      </FieldLabel>
      <FieldControl
        render={
          <Input
            name={field.path}
            onBlur={handleBlur}
            onChange={(e) => onChange(field.path, e.target.value)}
            type="text"
            value={typeof value === "string" ? value : ""}
          />
        }
      />
      <AiAdaptHint show={field.aiAdapt === true} />
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
  const arrayKey = `__array_${field.path}`;
  const items = readArrayIndices(values, arrayKey);

  const addItem = () => {
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
        <Button onClick={addItem} size="sm" variant="outline">
          <PlusIcon />
          {t("templates.addItem")}
        </Button>
      </div>

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
      const arrayKey = `__array_${field.path}`;
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
      const arrayKey = `__array_${field.path}`;
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
  fields,
  conditions,
  structureErrors,
  file,
  templateId,
  fileName,
  onBack,
  onDone,
  onValuesChange,
}: TemplateFormProps) => {
  const t = useTranslations();
  const [values, setValues] = useState<FormValues>(() =>
    buildInitialValues(fields),
  );
  useEffect(() => {
    onValuesChange?.(values);
  }, [values, onValuesChange]);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState<TouchedFields>({});
  const [errors, setErrors] = useState<FieldErrors>({});
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

  /** Re-validate on change when the field was already
   *  touched. Uses a ref so the touched check is never
   *  stale between blur and the next render. */
  const handleChangeWithValidation = useCallback(
    (path: string, value: unknown) => {
      handleChange(path, value);

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
    [handleChange, findFieldDef, resolveError],
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

  /** Validate all fields; returns true if valid. */
  const validateAll = useCallback(
    (currentValues: FormValues): boolean => {
      const all = collectValidatableFields(fields, currentValues, conditions);
      const nextErrors: FieldErrors = {};
      const nextTouched: TouchedFields = {};
      let valid = true;

      for (const { path, field } of all) {
        nextTouched[path] = true;
        const msg = resolveError(validateField(field, currentValues[path]));
        nextErrors[path] = msg;
        if (msg) {
          valid = false;
        }
      }

      setTouched((prev) => ({ ...prev, ...nextTouched }));
      setErrors(nextErrors);
      return valid;
    },
    [fields, conditions, resolveError],
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
          const msg = resolveError(validateField(f, values[path]));
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
      resolveError,
    ],
  );

  const handleSubmit = useCallback(
    (e: React.SubmitEvent<HTMLFormElement>) => {
      e.preventDefault();
      // Errors are surfaced as toasts inside handleDownload
      // TODO: fix this
      // oxlint-disable-next-line no-empty-function
      handleDownload("docx").catch(() => {});
    },
    [handleDownload],
  );

  // ── Fill preview ──────────────────────────────────
  type PreviewState =
    | { kind: "idle" }
    | { kind: "loading" }
    | {
        kind: "ready";
        paragraphs: { text: string; source?: string | undefined }[];
        unmatchedPlaceholders: string[];
        unusedValues: string[];
      };

  const [preview, setPreview] = useState<PreviewState>({
    kind: "idle",
  });

  const handlePreview = useCallback(async () => {
    if (!templateId) {
      return;
    }

    if (!validateAll(values)) {
      stellaToast.add({
        type: "error",
        title: t("templates.validationErrors"),
      });
      return;
    }

    setPreview({ kind: "loading" });

    const submitValues = buildSubmitValues(values, fields, conditions);
    const response = await api.templates({ templateId })["fill-preview"].post({
      values: JSON.stringify(submitValues),
    });

    if (response.error || response.data instanceof Response) {
      setPreview({ kind: "idle" });
      stellaToast.add({
        type: "error",
        title: t("templates.previewFailed"),
        description: response.error
          ? userErrorMessage(response.error, t("common.unexpectedError"))
          : undefined,
      });
      return;
    }

    const { data } = response;
    setPreview({
      kind: "ready",
      paragraphs: data.paragraphs,
      unmatchedPlaceholders: data.unmatchedPlaceholders,
      unusedValues: data.unusedValues,
    });
  }, [templateId, values, fields, conditions, validateAll, t]);

  // Filter visible non-array fields, then group
  const visibleScalarFields = fields.filter(
    (f) => f.kind !== "array" && isFieldVisible(f, values, conditions),
  );
  const grouped = groupFieldsByPrefix(visibleScalarFields);
  const arrayFields = fields.filter(
    (f) => f.kind === "array" && isFieldVisible(f, values, conditions),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl p-6">
        {/* Transient (upload) fill shows the form header + "upload different";
            server-side fill is embedded in the Studio's Fill tab, which labels
            itself, so the header would be redundant chrome. */}
        {file !== undefined && (
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t("templates.fillForm")}</h2>
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

        <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
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
              {prefix !== "" && groupSupportsRegistryAutofill(groupFields) && (
                <RegistryAutofillControl
                  groupFields={groupFields}
                  onApply={applyAutofill}
                />
              )}
              {groupFields.map((field) => (
                <FieldRenderer
                  error={touched[field.path] ? errors[field.path] : undefined}
                  field={field}
                  key={field.path}
                  onBlur={handleBlur}
                  onChange={handleChangeWithValidation}
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

          <div className="flex justify-end gap-2 pt-2">
            {templateId && (
              <Button
                disabled={loading || preview.kind === "loading"}
                onClick={() => {
                  void handlePreview();
                }}
                type="button"
                variant="ghost"
              >
                <EyeIcon />
                {preview.kind === "loading"
                  ? t("templates.previewFillLoading")
                  : t("common.preview")}
              </Button>
            )}
            <Button
              disabled={loading || hasErrors}
              onClick={() => {
                void handleDownload("pdf").catch(() => undefined);
              }}
              type="button"
              variant="outline"
            >
              {loading ? t("templates.generating") : t("templates.downloadPdf")}
            </Button>
            <Button disabled={loading || hasErrors} type="submit">
              {loading
                ? t("templates.generating")
                : t("templates.downloadDocx")}
            </Button>
          </div>
        </form>

        {/* Fill Preview Dialog */}
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setPreview({ kind: "idle" });
            }
          }}
          open={preview.kind === "ready"}
        >
          <DialogPopup className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t("templates.previewFillTitle")}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              {preview.kind === "ready" && (
                <>
                  {preview.unmatchedPlaceholders.length > 0 && (
                    <div className="border-warning/30 bg-warning/10 dark:bg-warning/10 mb-3 flex items-start gap-2 rounded-lg border p-2.5">
                      <AlertTriangleIcon className="text-warning-foreground mt-0.5 size-3.5 shrink-0" />
                      <p className="text-warning-foreground text-xs">
                        {t("templates.unmatchedPlaceholders", {
                          list: preview.unmatchedPlaceholders.join(", "),
                        })}
                      </p>
                    </div>
                  )}
                  {preview.unusedValues.length > 0 && (
                    <div className="border-foreground/30 bg-accent dark:bg-accent/30 mb-3 flex items-start gap-2 rounded-lg border p-2.5">
                      <AlertTriangleIcon className="text-foreground mt-0.5 size-3.5 shrink-0" />
                      <p className="text-foreground text-xs">
                        {t("templates.unusedValues", {
                          list: preview.unusedValues.join(", "),
                        })}
                      </p>
                    </div>
                  )}
                  <div className="bg-muted/30 max-h-96 overflow-y-auto rounded-lg border p-4">
                    {preview.paragraphs.map((p, i) => (
                      <p
                        className={cn(
                          "text-sm leading-relaxed",
                          !p.text.trim() && "min-h-4",
                        )}
                        key={`${p.source ?? "body"}-${String(i)}`}
                      >
                        {p.text || "\u00a0"}
                      </p>
                    ))}
                  </div>
                </>
              )}
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" />}>
                {t("common.done")}
              </DialogClose>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </div>
    </div>
  );
};
