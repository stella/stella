import { useCallback, useRef, useState } from "react";

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
import { AlertTriangleIcon, EyeIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { DOCX_MIME, PDF_MIME } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors";

type FillFormat = "docx" | "pdf";

const DOCX_EXT_RE = /\.docx$/i;

type DiscoverResponse = Awaited<ReturnType<typeof api.templates.discover.post>>;

type DiscoverData = Exclude<
  NonNullable<Extract<DiscoverResponse, { data: unknown }>["data"]>,
  Response
>;

type ResolvedField = DiscoverData["fields"][number];
type NamedCondition = DiscoverData["conditions"][number];
type StructureError = DiscoverData["structureErrors"][number];

const REQUIRED_MARKER = "*";

type FieldErrors = Record<string, string | undefined>;
type TouchedFields = Record<string, boolean>;

type ValidationError =
  | { kind: "required" }
  | { kind: "minLength"; min: number }
  | { kind: "maxLength"; max: number }
  | { kind: "numberMin"; min: number }
  | { kind: "numberMax"; max: number }
  | { kind: "pattern" };

/** Validate a single field value against its manifest
 *  rules. Returns a validation error or undefined. */
const validateField = (
  field: ResolvedField,
  value: unknown,
): ValidationError | undefined => {
  const required = field.required ?? field.validation?.required ?? false;
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

type TemplateFormProps = TransientFillProps | ServerFillProps;

type FormValues = Record<string, unknown>;

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
  const inputType =
    field.inputType ?? (field.kind === "boolean" ? "boolean" : "text");
  const label = field.label ?? field.path;
  const required = field.required ?? field.validation?.required ?? false;
  const handleBlur = () => onBlur?.(field.path);

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
          value={
            value === ""
              ? undefined
              : // SAFETY: inputType discriminates; value is string for select
                // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
                (value as string)
          }
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
              value={
                // SAFETY: inputType discriminates; value is string for textarea
                // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
                (value as string) ?? ""
              }
            />
          }
        />
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
              value={
                // SAFETY: inputType discriminates; value is string for number input
                // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
                (value as string) ?? ""
              }
            />
          }
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
            type={inputType === "date" ? "date" : "text"}
            value={
              // SAFETY: inputType discriminates; value is string for text/date
              // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
              (value as string) ?? ""
            }
          />
        }
      />
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
  // SAFETY: __array_* keys hold number[] from form state
  const items =
    // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    (values[arrayKey] as number[] | undefined) ?? [];

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
      // SAFETY: __array_* keys hold number[] from form state
      // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
      const items = (values[arrayKey] as number[] | undefined) ?? [];
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
    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = {};
    }
    // SAFETY: guarded by typeof current[part] === "object" above
    // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    current = current[part] as Record<string, unknown>;
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
      // SAFETY: __array_* keys hold number[] from form state
      // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
      const items = (values[arrayKey] as number[] | undefined) ?? [];
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

export const TemplateForm = ({
  fields,
  conditions,
  structureErrors,
  file,
  templateId,
  fileName,
  onBack,
  onDone,
}: TemplateFormProps) => {
  const t = useTranslations();
  const [values, setValues] = useState<FormValues>(() =>
    buildInitialValues(fields),
  );
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

      const response = templateId
        ? await api
            .templates({ templateId })
            .fill.post({ values: valuesJson }, { query: { format } })
        : await api.templates.fill.post(
            {
              // SAFETY: the discriminated union guarantees `file`
              // is defined when `templateId` is absent.
              // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
              file: file as File,
              values: valuesJson,
            },
            { query: { format } },
          );

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
            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
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
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("templates.fillForm")}</h2>
          <Button onClick={onBack} variant="ghost">
            {t("templates.uploadDifferent")}
          </Button>
        </div>

        {structureErrors.length > 0 && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-50 p-3 dark:bg-yellow-900/10">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-500" />
            <span className="text-sm text-yellow-800 dark:text-yellow-200">
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
                  : t("templates.previewFill")}
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
                    <div className="mb-3 flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-50 p-2.5 dark:bg-yellow-900/10">
                      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-yellow-600 dark:text-yellow-500" />
                      <p className="text-xs text-yellow-800 dark:text-yellow-200">
                        {t("templates.unmatchedPlaceholders", {
                          list: preview.unmatchedPlaceholders.join(", "),
                        })}
                      </p>
                    </div>
                  )}
                  {preview.unusedValues.length > 0 && (
                    <div className="mb-3 flex items-start gap-2 rounded-lg border border-blue-500/30 bg-blue-50 p-2.5 dark:bg-blue-900/10">
                      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-blue-600 dark:text-blue-500" />
                      <p className="text-xs text-blue-800 dark:text-blue-200">
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
