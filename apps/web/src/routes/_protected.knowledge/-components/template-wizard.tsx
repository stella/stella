import { useCallback, useRef, useState } from "react";

import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
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

import { LANG_ENDONYMS } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { inputTypeValueKind, VALUE_TYPE_META } from "@/lib/value-types";

import {
  type DraftCondition,
  draftToNamedCondition,
  emptyGroup,
  NamedConditionsEditor,
} from "./condition-builder";
import {
  DATE_FORMAT_STYLES,
  formatDateExample,
  type TemplateDateFormat,
} from "./template-date-format";

type DiscoverResponse = Awaited<ReturnType<typeof api.templates.discover.post>>;

type DiscoverData = Exclude<
  NonNullable<Extract<DiscoverResponse, { data: unknown }>["data"]>,
  Response
>;

export type ResolvedField = DiscoverData["fields"][number];
export type NamedCondition = DiscoverData["conditions"][number];
export type StructureError = DiscoverData["structureErrors"][number];

const DOCX_EXTENSION_RE = /\.docx$/iu;
const REQUIRED_MARKER = "*";

export const INPUT_TYPES = [
  "text",
  "textarea",
  "number",
  "boolean",
  "date",
  "select",
] as const;

type InputType = (typeof INPUT_TYPES)[number];

/**
 * Input types offered when configuring a field. A UI-level list, not the
 * manifest's `INPUT_TYPES`:
 *
 * - "boolean" is omitted — yes/no fields are condition questions, created via
 *   conditions; existing boolean fields keep rendering and working, they are
 *   just not offered for new configuration.
 * - "company" is added — the manifest has no "company" inputType. A company
 *   field is stored as inputType "text" plus `lookup` ({ registry, aiFormat }),
 *   and the UI derives the "company" choice back from lookup presence, so the
 *   manifest schema and the fill engine stay unchanged.
 */
export const FIELD_TYPE_CHOICES = [
  "text",
  "textarea",
  "number",
  "date",
  "select",
  "company",
] as const;

/** What the type picker (and the field row) shows: "company" when a lookup
 *  is configured, the manifest input type otherwise. */
const fieldTypeChoice = (field: EditableField): InputType | "company" =>
  field.lookup === undefined ? field.inputType : "company";

export const PART_INPUT_TYPES = ["text", "select"] as const;

type PartInputType = (typeof PART_INPUT_TYPES)[number];

/** Registries the lookup affordance offers; mirrors the manifest's
 *  supported set (only KRS for now). */
const LOOKUP_REGISTRIES = ["krs"] as const;

type LookupRegistry = (typeof LOOKUP_REGISTRIES)[number];

export type EditableLookup = {
  registry: LookupRegistry;
  /** AI instruction shaping the resolved company details; empty = the
   *  deterministic "name, seat" rendering. */
  aiFormat?: string | undefined;
};

export type EditablePart = {
  key: string;
  inputType: PartInputType;
  options: string[];
  label?: string | undefined;
  /** Round-tripped from the manifest; not editable in this UI. */
  pattern?: string | undefined;
};

export type EditableField = {
  path: string;
  kind: string;
  label: string;
  /** Short guidance for the person filling (shown as the input's
   *  placeholder in the fill form); empty/absent = none. */
  hint?: string | undefined;
  inputType: InputType;
  required: boolean;
  options: string[];
  /** Composite field: one value entered as several parts joined by `format`.
   *  Present iff `format` is present; `inputType` is then ignored for input
   *  rendering. */
  parts?: EditablePart[] | undefined;
  format?: string | undefined;
  /** Dependent select: path of the field whose entered values supply this
   *  select's options in the fill form; static options act as fallback. */
  optionsFrom?: string | undefined;
  /** Registry lookup: the person filling enters only the registry number;
   *  the server resolves the company at fill time. Text fields only. */
  lookup?: EditableLookup | undefined;
  /** Formula: the value is derived from other fields via an arithmetic
   *  expression at fill time; the fill form renders no input for it.
   *  Mutually exclusive with parts and lookup. */
  formula?: string | undefined;
  /** Locale-aware rendering of a "date" field's submitted ISO value at fill
   *  time; absent = the ISO value is substituted as typed. */
  dateFormat?: TemplateDateFormat | undefined;
};

const INPUT_TYPE_SET: ReadonlySet<string> = new Set(INPUT_TYPES);

/** Canonical icon + name for a field's value type (shared with the matter
 *  table's property chips via the value-type registry). */
export const ValueTypeLabel = ({
  inputType,
}: {
  inputType: InputType | "company";
}) => {
  const t = useTranslations();
  const meta = VALUE_TYPE_META[inputTypeValueKind(inputType)];
  const Icon = meta.icon;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
      <span className="truncate">{t(meta.labelKey)}</span>
    </span>
  );
};

export const isInputType = (value: string): value is InputType =>
  INPUT_TYPE_SET.has(value);

const inferInputType = (field: ResolvedField): InputType => {
  if (field.inputType && isInputType(field.inputType)) {
    return field.inputType;
  }
  if (field.kind === "boolean") {
    return "boolean";
  }
  if (field.options && field.options.length > 0) {
    return "select";
  }
  return "text";
};

export const buildEditableFields = (
  fields: readonly ResolvedField[],
): EditableField[] =>
  fields.map((f) => ({
    path: f.path,
    kind: f.kind,
    label: f.label ?? "",
    hint: f.hint,
    inputType: inferInputType(f),
    required: f.required ?? false,
    options: f.options ?? [],
    parts: f.parts?.map((part) => ({
      key: part.key,
      inputType: part.inputType,
      options: part.options ?? [],
      label: part.label,
      pattern: part.pattern,
    })),
    format: f.format,
    optionsFrom: f.optionsFrom,
    lookup: f.lookup,
    formula: f.formula,
    dateFormat: f.dateFormat,
  }));

type ManifestPart = {
  key: string;
  inputType: PartInputType;
  options?: string[] | undefined;
  label?: string | undefined;
  pattern?: string | undefined;
};

type CompositeManifestProps = {
  parts: ManifestPart[] | undefined;
  format: string | undefined;
};

/**
 * The manifest shape of a field's composite configuration: parts and format
 * are emitted together, or not at all (a half-configured composite — no parts
 * yet, or no format yet — saves as a plain field).
 */
export const defaultCompositeFormat = (
  parts: readonly EditablePart[],
): string | undefined => {
  const keys = parts.map((p) => p.key.trim()).filter((k) => k !== "");
  if (keys.length === 0) {
    return undefined;
  }
  return keys.map((k) => `{{${k}}}`).join(" ");
};

export const compositeManifestProps = (
  field: EditableField,
): CompositeManifestProps => {
  const parts = (field.parts ?? []).filter((part) => part.key.trim() !== "");
  // An untyped format defaults to all parts joined by spaces, so a composite
  // never silently degrades to a plain field just because the author skipped
  // the format input.
  const trimmedFormat = field.format?.trim() ?? "";
  const format =
    trimmedFormat === ""
      ? (defaultCompositeFormat(parts) ?? "")
      : trimmedFormat;
  if (parts.length === 0 || format === "") {
    return { parts: undefined, format: undefined };
  }
  return {
    parts: parts.map((part) => ({
      key: part.key,
      inputType: part.inputType,
      options:
        part.inputType === "select" && part.options.length > 0
          ? part.options
          : undefined,
      label: part.label || undefined,
      pattern: part.pattern || undefined,
    })),
    format,
  };
};

/**
 * The manifest shape of a field's lookup configuration: only meaningful on a
 * plain text field (composite parts and other input types collect a different
 * value), with a blank AI format instruction normalized away.
 */
export const lookupManifestProps = (
  field: EditableField,
): EditableLookup | undefined => {
  if (
    field.lookup === undefined ||
    field.parts !== undefined ||
    field.inputType !== "text"
  ) {
    return undefined;
  }
  const aiFormat = field.lookup.aiFormat?.trim() ?? "";
  return {
    registry: field.lookup.registry,
    aiFormat: aiFormat === "" ? undefined : aiFormat,
  };
};

/**
 * The manifest shape of a field's fill hint: the trimmed text, with a blank
 * one normalized away. Kept short — the input enforces {@link HINT_MAX_LENGTH}.
 */
export const hintManifestProps = (field: EditableField): string | undefined => {
  const hint = field.hint?.trim() ?? "";
  return hint === "" ? undefined : hint;
};

/**
 * The manifest shape of a field's date format: only meaningful on a plain
 * "date" input (composite, formula, and lookup fields collect or derive a
 * different value).
 */
export const dateFormatManifestProps = (
  field: EditableField,
): TemplateDateFormat | undefined => {
  if (
    field.inputType !== "date" ||
    field.parts !== undefined ||
    field.formula !== undefined ||
    field.lookup !== undefined
  ) {
    return undefined;
  }
  return field.dateFormat;
};

/**
 * The manifest shape of a field's formula: the trimmed expression, with a
 * blank one (the checkbox was ticked but no expression entered) normalized
 * away. A formula field's value is derived, never user-entered, so a
 * composite configuration takes precedence and suppresses the formula.
 */
export const formulaManifestProps = (
  field: EditableField,
): string | undefined => {
  if (field.formula === undefined || field.parts !== undefined) {
    return undefined;
  }
  const formula = field.formula.trim();
  return formula === "" ? undefined : formula;
};

type ConfigureStepProps = {
  file: File;
  fields: ResolvedField[];
  conditions: NamedCondition[];
  structureErrors: StructureError[];
  onBack: () => void;
  onSaved: () => void;
};

export const ConfigureStep = ({
  file,
  fields: discoveredFields,
  conditions,
  structureErrors,
  onBack,
  onSaved,
}: ConfigureStepProps) => {
  const t = useTranslations();
  const [name, setName] = useState(() =>
    file.name.replace(DOCX_EXTENSION_RE, ""),
  );
  const [fields, setFields] = useState(() =>
    buildEditableFields(discoveredFields),
  );
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [draftConditions, setDraftConditions] = useState<DraftCondition[]>([]);
  const [saving, setSaving] = useState(false);

  const updateField = useCallback(
    (path: string, patch: Partial<EditableField>) => {
      setFields((prev) =>
        prev.map((f) => (f.path === path ? { ...f, ...patch } : f)),
      );
    },
    [],
  );

  // Source-field choices for a dependent select's "options from field"
  // picker: every fillable path, with array fields contributing their item
  // paths (`parties.name`) since the array itself holds objects, not values.
  const fieldPathChoices = discoveredFields.flatMap((f) =>
    f.kind === "array"
      ? (f.itemFields ?? []).map((sub) => `${f.path}.${sub.path}`)
      : [f.path],
  );

  const handleSave = useCallback(
    async (e: React.SubmitEvent<HTMLFormElement>) => {
      e.preventDefault();

      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }

      setSaving(true);

      // Build manifest from editable field state
      const manifest = {
        version: 1,
        fields: fields.map((f) => {
          const formula = formulaManifestProps(f);
          if (formula !== undefined) {
            // Derived at fill time: no input is rendered, so the
            // input-source configuration (options, parts, lookup,
            // required) does not apply.
            return {
              path: f.path,
              label: f.label || undefined,
              inputType: f.inputType,
              formula,
            };
          }
          const composite = compositeManifestProps(f);
          return {
            path: f.path,
            label: f.label || undefined,
            hint: hintManifestProps(f),
            inputType: f.inputType,
            options:
              f.inputType === "select" && f.options.length > 0
                ? f.options
                : undefined,
            required: f.required || undefined,
            parts: composite.parts,
            format: composite.format,
            optionsFrom:
              f.inputType === "select" && f.optionsFrom
                ? f.optionsFrom
                : undefined,
            lookup: lookupManifestProps(f),
            dateFormat: dateFormatManifestProps(f),
          };
        }),
        conditions: [
          ...conditions,
          ...draftConditions
            .map(draftToNamedCondition)
            .filter(
              (c): c is { name: string; expression: string } => c !== null,
            ),
        ],
      };

      // Send the original DOCX + manifest to the create
      // endpoint; the server handles embedding and storage.
      const response = await api.templates.put({
        file,
        name: trimmed,
        manifest: JSON.stringify(manifest),
      });

      setSaving(false);

      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("templates.saveFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }

      stellaToast.add({
        type: "success",
        title: t("templates.templateSaved"),
      });
      onSaved();
    },
    [name, fields, conditions, draftConditions, file, t, onSaved],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Button onClick={onBack} size="sm" variant="ghost">
          <ArrowLeftIcon />
          {t("templates.backToList")}
        </Button>
      </div>
      <div className="mx-auto w-full max-w-2xl overflow-y-auto p-6">
        <div className="mb-6">
          <h2 className="text-lg font-semibold">
            {t("templates.configureFields")}
          </h2>
        </div>

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

        <form
          className="flex flex-col gap-5"
          onSubmit={(...args) => {
            void handleSave(...args);
          }}
        >
          <Field>
            <FieldLabel>{t("templates.templateName")}</FieldLabel>
            <FieldControl
              render={
                <Input
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("templates.templateNamePlaceholder")}
                  value={name}
                />
              }
            />
          </Field>

          <div className="rounded-lg border">
            <div className="border-b px-4 py-3">
              <h3 className="text-muted-foreground text-sm font-medium">
                {t("templates.fieldCount", {
                  count: fields.length,
                })}
              </h3>
            </div>
            <ul className="divide-y">
              {fields.map((field) => {
                const isExpanded = expandedField === field.path;
                return (
                  <li key={field.path}>
                    <button
                      className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-start text-sm"
                      onClick={() =>
                        setExpandedField(isExpanded ? null : field.path)
                      }
                      type="button"
                    >
                      {isExpanded ? (
                        <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
                      ) : (
                        <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 font-medium">
                        {field.label || field.path}
                      </span>
                      <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
                        <ValueTypeLabel inputType={fieldTypeChoice(field)} />
                      </span>
                      {field.required && (
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {REQUIRED_MARKER}
                        </span>
                      )}
                    </button>
                    {isExpanded && (
                      <FieldConfigEditor
                        field={field}
                        onUpdate={(patch) => updateField(field.path, patch)}
                        siblingPaths={fieldPathChoices.filter(
                          (p) => p !== field.path,
                        )}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="rounded-lg border">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="text-muted-foreground text-sm font-medium">
                {t("templates.conditionsTitle")}
              </h3>
              <Button
                onClick={() =>
                  setDraftConditions((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      name: "",
                      group: emptyGroup(),
                    },
                  ])
                }
                size="sm"
                type="button"
                variant="outline"
              >
                <PlusIcon />
                {t("templates.addCondition")}
              </Button>
            </div>
            {draftConditions.length > 0 && (
              <div className="p-4">
                <NamedConditionsEditor
                  conditions={draftConditions}
                  fields={fields.map((f) => f.path)}
                  onChange={setDraftConditions}
                />
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button disabled={saving || !name.trim()} type="submit">
              {t("common.save")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

/** Chip-style tag input for defining select options. */
const OptionsTagInput = ({
  options,
  onChange,
}: {
  options: string[];
  onChange: (options: string[]) => void;
}) => {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");

  const addOption = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || options.includes(trimmed)) {
        return;
      }
      onChange([...options, trimmed]);
    },
    [options, onChange],
  );

  const removeOption = useCallback(
    (index: number) => {
      onChange(options.filter((_, i) => i !== index));
    },
    [options, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addOption(draft);
        setDraft("");
        return;
      }
      if (e.key === "Backspace" && draft === "" && options.length > 0) {
        removeOption(options.length - 1);
      }
    },
    [draft, options, addOption, removeOption],
  );

  return (
    // TODO: fix this
    // oxlint-disable-next-line jsx_a11y/no-static-element-interactions, jsx_a11y/click-events-have-key-events
    <div
      className="border-input bg-background ring-ring/24 focus-within:border-ring flex min-h-9 w-full flex-wrap gap-1 rounded-lg border p-[calc(--spacing(1)-1px)] text-base shadow-xs/5 transition-shadow outline-none focus-within:ring-[3px] sm:min-h-8 sm:text-sm"
      onClick={() => inputRef.current?.focus()}
    >
      {options.map((option, i) => (
        <span
          className="bg-accent text-accent-foreground flex items-center rounded-md ps-2 text-sm font-medium sm:text-xs"
          key={option}
        >
          {option}
          <button
            className="h-full shrink-0 cursor-pointer px-1.5 opacity-80 hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              removeOption(i);
            }}
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        </span>
      ))}
      <input
        className="placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent px-1 outline-none"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          options.length === 0 ? t("templates.fieldOptionsPlaceholder") : ""
        }
        ref={inputRef}
        type="text"
        value={draft}
      />
    </div>
  );
};

const PART_KEY_DISALLOWED_RE = /[^\p{L}\p{N}_.-]/gu;

const emptyEditablePart = (): EditablePart => ({
  key: "",
  inputType: "text",
  options: [],
});

/** Editor for a composite field's parts: key + type per row (options chips
 *  for selects), plus the join format over `{{key}}` markers. */
const CompositePartsEditor = ({
  field,
  onUpdate,
}: {
  field: EditableField;
  onUpdate: (patch: Partial<EditableField>) => void;
}) => {
  const t = useTranslations();
  const parts = field.parts ?? [];

  const updatePart = (index: number, patch: Partial<EditablePart>) => {
    onUpdate({
      parts: parts.map((part, i) =>
        i === index ? { ...part, ...patch } : part,
      ),
    });
  };

  const formatPlaceholder = parts
    .filter((part) => part.key !== "")
    .map((part) => `{{${part.key}}}`)
    .join(" ");

  const formatInputRef = useRef<HTMLInputElement | null>(null);

  /** Insert a part token at the format input's caret (appends when the
   *  input has no focus memory) — nobody should need to type braces. */
  const insertPartToken = (key: string) => {
    const input = formatInputRef.current;
    const current = field.format ?? defaultCompositeFormat(parts) ?? "";
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? current.length;
    const token = `{{${key}}}`;
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
    onUpdate({ format: next });
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        {parts.map((part, index) => (
          <div
            className="flex flex-col gap-2"
            // Rows have no stable identity while their keys are edited.
            key={`part-${String(index)}`}
          >
            <div className="flex items-center gap-2">
              <Input
                aria-label={t("templates.fieldPartKeyPlaceholder")}
                className="flex-1"
                onChange={(e) =>
                  updatePart(index, {
                    key: e.target.value.replace(PART_KEY_DISALLOWED_RE, ""),
                  })
                }
                placeholder={t("templates.fieldPartKeyPlaceholder")}
                value={part.key}
              />
              <Select
                onValueChange={(val) => {
                  if (val === "text" || val === "select") {
                    updatePart(index, { inputType: val });
                  }
                }}
                value={part.inputType}
              >
                <SelectTrigger
                  aria-label={t("templates.fieldInputType")}
                  className="w-auto min-w-28"
                >
                  <SelectValue>
                    {() => <ValueTypeLabel inputType={part.inputType} />}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {PART_INPUT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      <ValueTypeLabel inputType={type} />
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                aria-label={t("common.remove")}
                onClick={() =>
                  onUpdate({ parts: parts.filter((_, i) => i !== index) })
                }
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </div>
            {part.inputType === "select" && (
              <OptionsTagInput
                onChange={(opts) => updatePart(index, { options: opts })}
                options={part.options}
              />
            )}
          </div>
        ))}
        <Button
          className="self-start"
          onClick={() => onUpdate({ parts: [...parts, emptyEditablePart()] })}
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon />
          {t("templates.addPart")}
        </Button>
      </div>

      <Field>
        <FieldLabel>{t("templates.fieldFormat")}</FieldLabel>
        <FieldControl
          render={
            <Input
              onChange={(e) => onUpdate({ format: e.target.value })}
              placeholder={formatPlaceholder}
              ref={formatInputRef}
              value={field.format ?? defaultCompositeFormat(parts) ?? ""}
            />
          }
        />
        <div className="flex flex-wrap items-center gap-1">
          {parts
            .map((part) => part.key.trim())
            .filter((key) => key !== "")
            .map((key) => (
              <Button
                key={key}
                onClick={() => insertPartToken(key)}
                size="xs"
                type="button"
                variant="outline"
              >
                {key}
              </Button>
            ))}
        </div>
        <p className="text-muted-foreground text-xs">
          {t("templates.fieldFormatHint")}
        </p>
      </Field>
    </>
  );
};

/** No-source choice in the dependent-select picker; "" never collides with a
 *  real path because the field-path grammar requires at least one character. */
const NO_SOURCE_FIELD = "";

/** Picker for a dependent select's source field (`optionsFrom`): the fill
 *  form derives the options from the values entered in that field, with the
 *  static options as fallback while it is empty. Without a sibling-path list
 *  (the Studio's embedded mode) it falls back to a typed path input limited
 *  to the field-path charset. */
const OptionsFromFieldControl = ({
  field,
  onUpdate,
  siblingPaths,
}: {
  field: EditableField;
  onUpdate: (patch: Partial<EditableField>) => void;
  siblingPaths?: readonly string[] | undefined;
}) => {
  const t = useTranslations();

  if (siblingPaths === undefined) {
    return (
      <Field>
        <FieldLabel>{t("templates.fieldOptionsFrom")}</FieldLabel>
        <FieldControl
          render={
            <Input
              onChange={(e) => {
                const next = e.target.value.replace(PART_KEY_DISALLOWED_RE, "");
                onUpdate({ optionsFrom: next === "" ? undefined : next });
              }}
              value={field.optionsFrom ?? ""}
            />
          }
        />
        <p className="text-muted-foreground text-xs">
          {t("templates.fieldOptionsFromHint")}
        </p>
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel>{t("templates.fieldOptionsFrom")}</FieldLabel>
      <Select
        onValueChange={(val) =>
          onUpdate({
            optionsFrom:
              typeof val === "string" && val !== NO_SOURCE_FIELD
                ? val
                : undefined,
          })
        }
        value={field.optionsFrom ?? NO_SOURCE_FIELD}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={NO_SOURCE_FIELD}>
            {t("templates.fieldOptionsFromNone")}
          </SelectItem>
          {siblingPaths.map((path) => (
            <SelectItem key={path} value={path}>
              {path}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <p className="text-muted-foreground text-xs">
        {t("templates.fieldOptionsFromHint")}
      </p>
    </Field>
  );
};

/** Registries offered for the "Company ID" field type, rendered as a
 *  structured list so new registries slot in as one entry. Mirrors
 *  `LOOKUP_REGISTRIES` in apps/api/src/handlers/docx/types.ts (itself a
 *  subset of the API's `BUSINESS_REGISTRY_SLUGS`); Eden exposes types only,
 *  so the slugs are mirrored here — extend together with the API. Labels are
 *  registry proper names, not translatable UI copy. */
const LOOKUP_REGISTRY_OPTIONS = [
  { slug: "krs", label: "Poland — KRS" },
] as const;

/** Detail names a registry hit returns, offered as clickable [placeholder]
 *  chips for the AI format instruction. The names follow the canonical
 *  fields of the API's `BusinessRegistryHitDetails` entry for the registry
 *  (`KrsEntity` for "krs": name, legalForm, registeredSeat, address,
 *  krsNumber, NIP/REGON identifiers, shareCapital). */
const REGISTRY_RETURN_FIELDS: Record<LookupRegistry, readonly string[]> = {
  krs: [
    "company name",
    "legal form",
    "seat",
    "address",
    "registry number",
    "NIP",
    "REGON",
    "share capital",
  ],
};

/** Configuration for the "Company ID" field type: pick the register the
 *  entered number resolves against, and optionally an AI format instruction
 *  shaping the resolved company details — with the registry's return fields
 *  as clickable chips that insert [placeholder] tokens. */
const CompanyLookupConfig = ({
  field,
  onUpdate,
}: {
  field: EditableField;
  onUpdate: (patch: Partial<EditableField>) => void;
}) => {
  const t = useTranslations();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const registry = field.lookup?.registry ?? "krs";
  const aiFormat = field.lookup?.aiFormat ?? "";

  const setLookup = (patch: Partial<EditableLookup>) =>
    onUpdate({ lookup: { registry, aiFormat, ...patch } });

  /** Insert a [detail] token at the textarea caret (appends when the
   *  textarea has not been focused yet) and restore focus. */
  const insertToken = (name: string) => {
    const token = `[${name}]`;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? aiFormat.length;
    const end = textarea?.selectionEnd ?? aiFormat.length;
    setLookup({
      aiFormat: aiFormat.slice(0, start) + token + aiFormat.slice(end),
    });
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <>
      <Field>
        <FieldLabel>{t("templates.fieldLookupRegistry")}</FieldLabel>
        <Select
          onValueChange={(val) => {
            const option = LOOKUP_REGISTRY_OPTIONS.find((o) => o.slug === val);
            if (option) {
              setLookup({ registry: option.slug });
            }
          }}
          value={registry}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {LOOKUP_REGISTRY_OPTIONS.map((option) => (
              <SelectItem key={option.slug} value={option.slug}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <p className="text-muted-foreground text-xs">
          {t("templates.fieldLookupHint")}
        </p>
      </Field>

      <Field>
        <FieldLabel>{t("templates.fieldLookupAiFormat")}</FieldLabel>
        <FieldControl
          render={
            <Textarea
              onChange={(e) => setLookup({ aiFormat: e.target.value })}
              placeholder={t("templates.fieldLookupAiFormatPlaceholder")}
              ref={textareaRef}
              value={aiFormat}
            />
          }
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">
            {t("templates.fieldLookupInsertDetail")}
          </span>
          {REGISTRY_RETURN_FIELDS[registry].map((name) => (
            <button
              className="bg-accent text-accent-foreground hover:bg-accent/80 cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium"
              key={name}
              onClick={() => insertToken(name)}
              type="button"
            >
              [{name}]
            </button>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          {t("templates.fieldLookupAiFormatHint")}
        </p>
      </Field>
    </>
  );
};

/** Locale + style picker for a "date" field's locale-aware rendering. The
 *  style choices are self-describing: each shows the exemplar date rendered
 *  in the selected locale. Picking the "iso" style with no stored format
 *  keeps the format unset (both substitute the typed ISO value). */
const DateFormatConfigControl = ({
  field,
  onUpdate,
  defaultLocale,
}: {
  field: EditableField;
  onUpdate: (patch: Partial<EditableField>) => void;
  /** Locale preselected before the user picks one — the template's primary
   *  language when the host knows it, the app locale otherwise. */
  defaultLocale: string;
}) => {
  const t = useTranslations();
  const locale = field.dateFormat?.locale ?? defaultLocale;
  const style = field.dateFormat?.style ?? "iso";

  // The supported UI languages, plus the stored locale when it is not one of
  // them (a template's document language is not limited to UI languages).
  const localeChoices: { tag: string; label: string }[] = Object.entries(
    LANG_ENDONYMS,
  ).map(([tag, label]) => ({ tag, label }));
  if (!localeChoices.some((choice) => choice.tag === locale)) {
    localeChoices.unshift({ tag: locale, label: locale });
  }

  const setDateFormat = (next: TemplateDateFormat) =>
    onUpdate({ dateFormat: next });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field className="w-auto min-w-36">
        <FieldLabel>{t("common.language")}</FieldLabel>
        <Select
          onValueChange={(val) => {
            if (typeof val === "string" && val !== "") {
              setDateFormat({ locale: val, style });
            }
          }}
          value={locale}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {localeChoices.map((choice) => (
              <SelectItem key={choice.tag} value={choice.tag}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      <Field className="w-auto min-w-44">
        <FieldLabel>{t("templates.dateFormatStyle")}</FieldLabel>
        <Select
          onValueChange={(val) => {
            const next = DATE_FORMAT_STYLES.find((s) => s === val);
            if (next !== undefined) {
              setDateFormat({ locale, style: next });
            }
          }}
          value={style}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {DATE_FORMAT_STYLES.map((styleChoice) => (
              <SelectItem key={styleChoice} value={styleChoice}>
                {formatDateExample({ locale, style: styleChoice })}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
    </div>
  );
};

/** Formula affordance: the field's value is derived from other fields via an
 *  arithmetic expression at fill time, so the fill form asks for nothing.
 *  Mutually exclusive with the other value sources; enabling it clears the
 *  registry lookup. */
const FormulaConfigControl = ({
  field,
  onUpdate,
}: {
  field: EditableField;
  onUpdate: (patch: Partial<EditableField>) => void;
}) => {
  const t = useTranslations();

  return (
    <>
      <Field>
        <div className="flex items-center gap-2">
          <Checkbox
            checked={field.formula !== undefined}
            onCheckedChange={(checked) =>
              onUpdate(
                checked
                  ? { formula: field.formula ?? "", lookup: undefined }
                  : { formula: undefined },
              )
            }
          />
          <FieldLabel>{t("templates.fieldFormulaEnable")}</FieldLabel>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("templates.fieldFormulaHint")}
        </p>
      </Field>

      {field.formula !== undefined && (
        <Field>
          <FieldLabel>{t("templates.fieldFormulaExpression")}</FieldLabel>
          <FieldControl
            render={
              <Input
                className="font-mono"
                onChange={(e) => onUpdate({ formula: e.target.value })}
                value={field.formula}
              />
            }
          />
          <p className="text-muted-foreground text-xs">
            {t("templates.fieldFormulaExpressionHint")}
          </p>
        </Field>
      )}
    </>
  );
};

/** Hint length cap mirrored by the manifest's expectation of short hints. */
const HINT_MAX_LENGTH = 200;

export const FieldConfigEditor = ({
  field,
  onUpdate,
  embedded = false,
  siblingPaths,
  hideFormulaControl = false,
  defaultDateLocale,
}: {
  field: EditableField;
  onUpdate: (patch: Partial<EditableField>) => void;
  /** Embedded in the Studio's field face: the face header already shows the
   *  path, and the wizard's chevron-row indent doesn't apply. */
  embedded?: boolean;
  /** Paths of the template's other fields, offered as sources for a
   *  dependent select's options; a typed path input is shown when absent. */
  siblingPaths?: readonly string[] | undefined;
  /** The host renders its own formula affordance (the Studio's source
   *  picker); drop the built-in control to avoid duplicating it. */
  hideFormulaControl?: boolean;
  /** Preselected locale for a date field's format picker — the template's
   *  primary language when the host knows it; app locale otherwise. */
  defaultDateLocale?: string | undefined;
}) => {
  const t = useTranslations();
  const appLocale = useLocale();
  const isComposite = field.parts !== undefined;
  const isFormula = field.formula !== undefined;
  const typeChoice = fieldTypeChoice(field);

  return (
    <div
      className={cn(
        "bg-muted/30 flex flex-col gap-4 border-t px-4 py-4",
        !embedded && "ps-11",
      )}
    >
      {!embedded && (
        <p className="bg-muted/60 text-muted-foreground rounded px-3 py-2 text-xs leading-relaxed">
          <code>{field.path}</code>
        </p>
      )}

      <Field>
        <FieldLabel>{t("templates.fieldLabel")}</FieldLabel>
        <FieldControl
          render={
            <Input
              onChange={(e) => onUpdate({ label: e.target.value })}
              placeholder={t("templates.fieldLabelPlaceholder")}
              value={field.label}
            />
          }
        />
      </Field>

      {!isComposite && !isFormula && (
        <Field>
          <FieldLabel>{t("templates.fieldInputType")}</FieldLabel>
          <Select
            onValueChange={(val) => {
              if (val === "company") {
                // "company" maps to inputType "text" + lookup (see
                // FIELD_TYPE_CHOICES); keep an existing lookup config.
                onUpdate({
                  inputType: "text",
                  lookup: field.lookup ?? { registry: "krs" },
                });
                return;
              }
              if (val && isInputType(val)) {
                onUpdate({ inputType: val, lookup: undefined });
              }
            }}
            value={typeChoice}
          >
            <SelectTrigger>
              <SelectValue>
                {() => <ValueTypeLabel inputType={typeChoice} />}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {FIELD_TYPE_CHOICES.map((type) => (
                <SelectItem key={type} value={type}>
                  <ValueTypeLabel inputType={type} />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      )}

      {!isFormula && (
        <Field>
          <FieldLabel>{t("templates.fieldHint")}</FieldLabel>
          <FieldControl
            render={
              <Input
                maxLength={HINT_MAX_LENGTH}
                onChange={(e) => onUpdate({ hint: e.target.value })}
                value={field.hint ?? ""}
              />
            }
          />
        </Field>
      )}

      {!isFormula && (
        <Field>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={field.required}
              onCheckedChange={(checked) => onUpdate({ required: checked })}
            />
            <FieldLabel>{t("common.required")}</FieldLabel>
          </div>
        </Field>
      )}

      {!isFormula && typeChoice !== "company" && (
        <Field>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={isComposite}
              onCheckedChange={(checked) => {
                if (checked) {
                  onUpdate({
                    parts: field.parts ?? [emptyEditablePart()],
                    format: field.format ?? "",
                  });
                  return;
                }
                onUpdate({ parts: undefined, format: undefined });
              }}
            />
            <FieldLabel>{t("templates.fieldMultipleParts")}</FieldLabel>
          </div>
        </Field>
      )}

      {isComposite && (
        <CompositePartsEditor field={field} onUpdate={onUpdate} />
      )}

      {!isComposite && !hideFormulaControl && typeChoice !== "company" && (
        <FormulaConfigControl field={field} onUpdate={onUpdate} />
      )}

      {!isComposite && !isFormula && typeChoice === "company" && (
        <CompanyLookupConfig field={field} onUpdate={onUpdate} />
      )}

      {!isComposite && !isFormula && typeChoice === "date" && (
        <DateFormatConfigControl
          defaultLocale={defaultDateLocale ?? appLocale}
          field={field}
          onUpdate={onUpdate}
        />
      )}

      {!isComposite && !isFormula && field.inputType === "select" && (
        <>
          <Field>
            <FieldLabel>{t("templates.fieldOptions")}</FieldLabel>
            <OptionsTagInput
              onChange={(opts) => onUpdate({ options: opts })}
              options={field.options}
            />
          </Field>
          <OptionsFromFieldControl
            field={field}
            onUpdate={onUpdate}
            siblingPaths={siblingPaths}
          />
        </>
      )}
    </div>
  );
};
