import { useCallback, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Checkbox } from "@stella/ui/components/checkbox";
import { Field, FieldControl, FieldLabel } from "@stella/ui/components/field";
import { Input } from "@stella/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";

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

export type InputType = (typeof INPUT_TYPES)[number];

export type EditableField = {
  path: string;
  kind: string;
  label: string;
  inputType: InputType;
  required: boolean;
  options: string[];
};

const inferInputType = (field: ResolvedField): InputType => {
  if (field.inputType) {
    return field.inputType as InputType;
  }
  if (field.kind === "boolean") {
    return "boolean";
  }
  if (field.options && field.options.length > 0) {
    return "select";
  }
  return "text";
};

export const buildEditableFields = (fields: ResolvedField[]): EditableField[] =>
  fields.map((f) => ({
    path: f.path,
    kind: f.kind,
    label: f.label ?? "",
    inputType: inferInputType(f),
    required: f.required ?? false,
    options: f.options ?? [],
  }));

export type ConfigureStepProps = {
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
  const [name, setName] = useState(file.name.replace(DOCX_EXTENSION_RE, ""));
  const [fields, setFields] = useState(() =>
    buildEditableFields(discoveredFields),
  );
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateField = useCallback(
    (path: string, patch: Partial<EditableField>) => {
      setFields((prev) =>
        prev.map((f) => (f.path === path ? { ...f, ...patch } : f)),
      );
    },
    [],
  );

  const handleSave = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }

      setSaving(true);

      // Build manifest from editable field state
      const manifest = {
        version: 1,
        fields: fields.map((f) => ({
          path: f.path,
          label: f.label || undefined,
          inputType: f.inputType,
          options:
            f.inputType === "select" && f.options.length > 0
              ? f.options
              : undefined,
          required: f.required || undefined,
        })),
        conditions,
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
        toastManager.add({
          type: "error",
          title: t("templates.saveFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }

      toastManager.add({
        type: "success",
        title: t("templates.templateSaved"),
      });
      onSaved();
    },
    [name, fields, conditions, file, t, onSaved],
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
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-50 p-3 dark:bg-yellow-900/10">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-500" />
            <span className="text-sm text-yellow-800 dark:text-yellow-200">
              {t("templates.structureWarnings", {
                count: structureErrors.length,
              })}
            </span>
          </div>
        )}

        <form className="flex flex-col gap-5" onSubmit={handleSave}>
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
              <h3 className="text-sm font-medium text-muted-foreground">
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
                      className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/50"
                      onClick={() =>
                        setExpandedField(isExpanded ? null : field.path)
                      }
                      type="button"
                    >
                      {isExpanded ? (
                        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 font-medium">
                        {field.label || field.path}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t(`templates.inputTypes.${field.inputType}`)}
                      </span>
                      {field.required && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {REQUIRED_MARKER}
                        </span>
                      )}
                    </button>
                    {isExpanded && (
                      <FieldConfigEditor
                        field={field}
                        onUpdate={(patch) => updateField(field.path, patch)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: focus delegation
    // biome-ignore lint/a11y/noStaticElementInteractions: focus delegation
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: focus delegation
    <div
      className="flex min-h-9 w-full flex-wrap gap-1 rounded-lg border border-input bg-background p-[calc(--spacing(1)-1px)] text-base shadow-xs/5 ring-ring/24 transition-shadow outline-none focus-within:border-ring focus-within:ring-[3px] sm:min-h-8 sm:text-sm"
      onClick={() => inputRef.current?.focus()}
    >
      {options.map((option, i) => (
        <span
          className="flex items-center rounded-md bg-accent ps-2 text-sm font-medium text-accent-foreground sm:text-xs"
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
        className="min-w-24 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground"
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

export const FieldConfigEditor = ({
  field,
  onUpdate,
}: {
  field: EditableField;
  onUpdate: (patch: Partial<EditableField>) => void;
}) => {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-4 border-t bg-muted/30 px-4 py-4 pl-11">
      <p className="rounded bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <code>{field.path}</code>
      </p>

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

      <Field>
        <FieldLabel>{t("templates.fieldInputType")}</FieldLabel>
        <Select
          onValueChange={(val) => onUpdate({ inputType: val as InputType })}
          value={field.inputType}
        >
          <SelectTrigger>
            <SelectValue>
              {() => t(`templates.inputTypes.${field.inputType}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {INPUT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`templates.inputTypes.${type}`)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>

      <Field>
        <div className="flex items-center gap-2">
          <Checkbox
            checked={field.required}
            onCheckedChange={(checked) =>
              onUpdate({ required: checked === true })
            }
          />
          <FieldLabel>{t("common.required")}</FieldLabel>
        </div>
      </Field>

      {field.inputType === "select" && (
        <Field>
          <FieldLabel>{t("templates.fieldOptions")}</FieldLabel>
          <OptionsTagInput
            onChange={(opts) => onUpdate({ options: opts })}
            options={field.options}
          />
        </Field>
      )}
    </div>
  );
};
