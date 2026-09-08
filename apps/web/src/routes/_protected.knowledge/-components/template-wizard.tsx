import { useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import { Field, FieldControl, FieldLabel } from "@stll/ui/field";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";
import { contentDir } from "@stll/ui/use-content-dir";
import { cn } from "@stll/ui/utils";

import {
  REGISTRY_DEFAULT_FORMAT,
  REGISTRY_FIELD_EXAMPLES,
  REGISTRY_RETURN_FIELDS,
} from "@/components/templates/registry-format-config";
import {
  LOOKUP_REGISTRY_OPTIONS,
  type LookupRegistryOption,
} from "@/components/templates/registry-options";
import {
  DATE_FORMAT_STYLES,
  formatDateExample,
  type TemplateDateFormat,
} from "@/components/templates/template-date-format";
import {
  isInputType,
  type InputType,
  type LookupRegistry,
} from "@/components/templates/template-field-manifest";
import Tooltip from "@/components/tooltip";
import { useLocale } from "@/i18n/formatting-context";
import { LANG_ENDONYMS } from "@/i18n/i18n-store";
import type { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { bindingCatalogOptions } from "@/lib/knowledge/queries/binding-catalog";
import { inputTypeValueKind, VALUE_TYPE_META } from "@/lib/value-types";
import type {
  EditableField,
  EditableLookup,
  EditableLookupFormat,
  FieldSource,
  TemplateEditableField,
} from "@/routes/_protected.knowledge/-components/template-value-source";

/**
 * Input types offered when configuring a field. A UI-level list, not the
 * manifest's `InputType`:
 *
 * - "boolean" is omitted — yes/no fields are condition questions, created via
 *   conditions; existing boolean fields keep rendering and working, they are
 *   just not offered for new configuration.
 * - "company" is added — the manifest has no "company" inputType. A company
 *   field is stored as inputType "text" plus `lookup` ({ registry, formats }),
 *   and the UI derives the "company" choice back from lookup presence, so the
 *   manifest schema and the fill engine stay unchanged.
 */
// "textarea" is intentionally absent: authors pick a single "text" type that
// fills as an auto-growing input handling short and long values alike.
const FIELD_TYPE_CHOICES = [
  "text",
  "number",
  "date",
  "select",
  "company",
] as const;

/** What the type picker (and the field row) shows: "company" when a lookup
 *  is configured, the manifest input type otherwise. */
const fieldTypeChoice = (
  field: TemplateEditableField,
): InputType | "company" =>
  field.lookup === undefined ? field.inputType : "company";

/** Default key seeded for the first format of a freshly switched Company ID
 *  field; the author can rename it. */
const LOOKUP_DEFAULT_FORMAT_KEY = "output_1";

/** Characters disallowed in a format key as the author types: anything outside
 *  the segment grammar, including the dot (the marker's path/key separator). */
const LOOKUP_FORMAT_KEY_DISALLOWED_RE = /[^\p{L}\p{N}_-]/gu;

/** Caps mirroring the manifest's `LOOKUP_FORMATS_MAX` /
 *  `LOOKUP_FORMAT_TEMPLATE_MAX_LENGTH`. */
const LOOKUP_FORMATS_MAX = 10;
const LOOKUP_FORMAT_TEMPLATE_MAX_LENGTH = 2000;

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

  const addOption = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || options.includes(trimmed)) {
      return;
    }
    onChange([...options, trimmed]);
  };

  const removeOption = (index: number) => {
    onChange(options.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addOption(draft);
      setDraft("");
      return;
    }
    if (e.key === "Backspace" && draft === "" && options.length > 0) {
      removeOption(options.length - 1);
    }
  };

  return (
    // oxlint-disable-next-line jsx_a11y/no-static-element-interactions, jsx_a11y/click-events-have-key-events -- wrapper extends click target to focus the nested input; the input is natively keyboard-focusable
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
          <Tooltip
            content={t("common.remove")}
            render={
              <button
                aria-label={t("common.remove")}
                className="h-full shrink-0 cursor-pointer px-1.5 opacity-80 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  removeOption(i);
                }}
                type="button"
              >
                <XIcon className="size-3.5" />
              </button>
            }
          />
        </span>
      ))}
      <input
        className="placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent px-1 outline-none"
        dir={contentDir(draft)}
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

/** Field-path grammar (letters, digits, underscore, dash, dot) for the typed
 *  source-field input, so a path the marker scanner refuses cannot be typed. */
const FIELD_PATH_DISALLOWED_RE = /[^\p{L}\p{N}_.-]/gu;

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
  field: TemplateEditableField;
  onUpdate: (patch: Partial<TemplateEditableField>) => void;
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
                const next = e.target.value.replace(
                  FIELD_PATH_DISALLOWED_RE,
                  "",
                );
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

/** The app locale's region (ISO 3166-1 alpha-2), or null when the locale has
 *  no resolvable region. `maximize()` adds the likely region for
 *  language-only locales (e.g. "en" → "US", "cs" → "CZ"). */
const localeRegion = (locale: string): string | null => {
  const region = new Intl.Locale(locale).maximize().region;
  return region ?? null;
};

/** Registry options ordered jurisdiction-first for the app locale: options
 *  whose `country` matches the locale's region come first (in declared order),
 *  then the rest (in declared order). */
const orderedRegistryOptions = (
  locale: string,
): readonly LookupRegistryOption[] => {
  const region = localeRegion(locale);
  if (region === null) {
    return LOOKUP_REGISTRY_OPTIONS;
  }
  const local = LOOKUP_REGISTRY_OPTIONS.filter(
    (option) => option.country === region,
  );
  const rest = LOOKUP_REGISTRY_OPTIONS.filter(
    (option) => option.country !== region,
  );
  return [...local, ...rest];
};

/** The registry preselected for a new "Company ID" field: the jurisdiction's
 *  own registry (the first option for the app locale). It may be deploy-gated
 *  or org-disabled in a given environment — the frontend can't know — but
 *  fill-time resolution gates on both and surfaces a clear, actionable error
 *  ("not available in this deployment" / "disabled for this organization") so
 *  the author switches registry. That beats defaulting to an unrelated
 *  jurisdiction's registry, which can be just as unavailable and is wrong by
 *  default. The ordered list is a non-empty permutation of
 *  `LOOKUP_REGISTRY_OPTIONS`; the `?? "krs"` only satisfies the type checker. */
const preferredRegistry = (locale: string): LookupRegistry =>
  orderedRegistryOptions(locale).at(0)?.slug ?? "krs";

type InsertTokenResult = {
  value: string;
  restoreCaret: () => void;
};

/** Insert `token` at the textarea's caret (appending when it has not been
 *  focused yet), returning the next value plus a deferred caret restore so
 *  every format editor shares one caret-insertion mechanism. */
const insertTokenAtCaret = (
  textarea: HTMLTextAreaElement | null,
  current: string,
  token: string,
): InsertTokenResult => {
  const start = textarea?.selectionStart ?? current.length;
  const end = textarea?.selectionEnd ?? current.length;
  const value = current.slice(0, start) + token + current.slice(end);
  return {
    value,
    restoreCaret: () => {
      requestAnimationFrame(() => {
        textarea?.focus();
        textarea?.setSelectionRange(start + token.length, start + token.length);
      });
    },
  };
};

/** Configuration for the "Company ID" field type: pick the register the
 *  entered number resolves against, then edit the output formats. The formats
 *  list is the whole config: the first row is the default rendering for the
 *  bare `{{path}}` marker, every later row is a named rendering addressed by
 *  `{{path.key}}`. Each row's template uses the registry's return fields as
 *  clickable chips that insert [placeholder] tokens. */
const CompanyLookupConfig = ({
  field,
  onUpdate,
}: {
  field: TemplateEditableField;
  onUpdate: (patch: Partial<TemplateEditableField>) => void;
}) => {
  const t = useTranslations();
  const locale = useLocale();
  const registry = field.lookup?.registry ?? preferredRegistry(locale);
  const formats = optionalArray(field.lookup?.formats);
  const options = orderedRegistryOptions(locale);
  const selectedOption =
    options.find((option) => option.slug === registry) ?? null;

  const setLookup = (patch: Partial<EditableLookup>) =>
    onUpdate({ lookup: { registry, formats, ...patch } });

  const updateFormat = (index: number, patch: Partial<EditableLookupFormat>) =>
    setLookup({
      formats: formats.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    });

  const addFormat = () =>
    setLookup({ formats: [...formats, { key: "", template: "" }] });

  const removeFormat = (index: number) =>
    setLookup({ formats: formats.filter((_, i) => i !== index) });

  // On a registry switch, reseed the first (default) format row with the new
  // registry's recital ONLY when the author has not written their own: the
  // first row is empty, or it still equals the previous registry's default.
  // Otherwise the author's edits are left untouched.
  const changeRegistry = (next: LookupRegistry) => {
    if (next === registry) {
      return;
    }
    const first = formats.at(0);
    const firstTemplate = first?.template.trim() ?? "";
    const isUntouched =
      firstTemplate === "" ||
      firstTemplate === REGISTRY_DEFAULT_FORMAT[registry];
    if (first === undefined || !isUntouched) {
      setLookup({ registry: next });
      return;
    }
    const reseeded = [
      { ...first, template: REGISTRY_DEFAULT_FORMAT[next] },
      ...formats.slice(1),
    ];
    setLookup({ registry: next, formats: reseeded });
  };

  return (
    <>
      <Field>
        <FieldLabel>{t("templates.fieldLookupRegistry")}</FieldLabel>
        <Combobox<LookupRegistryOption>
          autoHighlight
          items={options}
          itemToStringLabel={(option) => option.label}
          onValueChange={(option) => {
            if (option) {
              changeRegistry(option.slug);
            }
          }}
          value={selectedOption}
        >
          <ComboboxInput
            placeholder={t("templates.fieldLookupRegistrySearch")}
          />
          <ComboboxPopup>
            <ComboboxList>
              {(option: LookupRegistryOption) => (
                <ComboboxItem key={option.slug} value={option}>
                  {option.label}
                </ComboboxItem>
              )}
            </ComboboxList>
            <ComboboxEmpty>{t("common.noResults")}</ComboboxEmpty>
          </ComboboxPopup>
        </Combobox>
      </Field>

      <Field>
        <FieldLabel>{t("templates.fieldLookupFormats")}</FieldLabel>
        <p className="text-muted-foreground text-xs">
          {t("templates.fieldLookupFormatsHint")}
        </p>
        <div className="flex flex-col gap-3">
          {formats.map((format, index) => (
            <LookupFormatRow
              fieldPath={field.path}
              format={format}
              isDefault={index === 0}
              // Rows have no stable identity while their keys are edited.
              key={`lookup-format-${String(index)}`}
              onChange={(patch) => updateFormat(index, patch)}
              // The list must stay non-empty: never offer to remove the last.
              onRemove={
                formats.length > 1 ? () => removeFormat(index) : undefined
              }
              registry={registry}
            />
          ))}
        </div>
        <Button
          className="self-start"
          disabled={formats.length >= LOOKUP_FORMATS_MAX}
          onClick={addFormat}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("templates.fieldLookupAddFormat")}
        </Button>
      </Field>
    </>
  );
};

/** The registry's return fields as clickable chips that insert [token] slots
 *  at the active format editor's caret. Shared by the default format and every
 *  named-format row. */
const LookupTokenChips = ({
  registry,
  onInsert,
}: {
  registry: LookupRegistry;
  onInsert: (name: string) => void;
}) => {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground text-xs">
        {t("templates.fieldLookupInsertDetail")}
      </span>
      {REGISTRY_RETURN_FIELDS[registry].map((name) => (
        <LookupTokenChip
          example={REGISTRY_FIELD_EXAMPLES[registry]?.[name]}
          key={name}
          name={name}
          onInsert={onInsert}
        />
      ))}
    </div>
  );
};

/** One token chip: a tooltip-wrapped button when the registry has a curated
 *  example for the token, the bare button otherwise. */
const LookupTokenChip = ({
  name,
  example,
  onInsert,
}: {
  name: string;
  example: string | undefined;
  onInsert: (name: string) => void;
}) => {
  const button = (
    <button
      className="bg-accent text-accent-foreground hover:bg-accent/80 cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium"
      onClick={() => onInsert(name)}
      type="button"
    >
      [{name}]
    </button>
  );
  if (example === undefined) {
    return button;
  }
  return <Tooltip content={example} render={button} />;
};

/** One output-format row: a key input, the template Textarea with the
 *  return-field token chips, an optional remove button, and muted helper text
 *  showing the marker the author types to use this rendering. The first
 *  (default) row renders for the bare `{{path}}` marker; later rows are keyed
 *  `{{path.key}}`. */
const LookupFormatRow = ({
  fieldPath,
  format,
  isDefault,
  registry,
  onChange,
  onRemove,
}: {
  fieldPath: string;
  format: EditableLookupFormat;
  /** The first format in the list: rendered for the bare `{{path}}` marker. */
  isDefault: boolean;
  registry: LookupRegistry;
  onChange: (patch: Partial<EditableLookupFormat>) => void;
  /** Absent on the last remaining row, which must not be removable. */
  onRemove?: (() => void) | undefined;
}) => {
  const t = useTranslations();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertToken = (name: string) => {
    const next = insertTokenAtCaret(
      textareaRef.current,
      format.template,
      `[${name}]`,
    );
    onChange({ template: next.value });
    next.restoreCaret();
  };

  const trimmedKey = format.key.trim();

  return (
    <div className="border-border flex flex-col gap-2 rounded-md border p-2">
      <div className="flex items-center gap-2">
        <Input
          aria-label={t("templates.fieldLookupFormatKey")}
          className="flex-1"
          onChange={(e) =>
            onChange({
              key: e.target.value.replace(LOOKUP_FORMAT_KEY_DISALLOWED_RE, ""),
            })
          }
          placeholder={t("templates.fieldLookupFormatKey")}
          value={format.key}
        />
        {onRemove !== undefined && (
          <Button
            aria-label={t("common.remove")}
            onClick={onRemove}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon />
          </Button>
        )}
      </div>
      <FieldControl
        render={
          <Textarea
            aria-label={t("templates.fieldLookupFormatTemplate")}
            maxLength={LOOKUP_FORMAT_TEMPLATE_MAX_LENGTH}
            onChange={(e) => onChange({ template: e.target.value })}
            placeholder={t("templates.fieldLookupAiFormatPlaceholder")}
            ref={textareaRef}
            value={format.template}
          />
        }
      />
      <LookupTokenChips onInsert={insertToken} registry={registry} />
      <FormatMarkerHint
        fieldPath={fieldPath}
        isDefault={isDefault}
        trimmedKey={trimmedKey}
      />
    </div>
  );
};

/** Muted helper text naming the marker that renders a format: `{{path}}` for
 *  the default row, `{{path.key}}` for keyed rows (shown once the key is set). */
const FormatMarkerHint = ({
  fieldPath,
  isDefault,
  trimmedKey,
}: {
  fieldPath: string;
  isDefault: boolean;
  trimmedKey: string;
}) => {
  const t = useTranslations();
  if (isDefault) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("templates.fieldLookupFormatDefaultMarker")}
        <code className="bg-muted ms-1 rounded px-1 py-0.5">
          {`{{${fieldPath}}}`}
        </code>
      </p>
    );
  }
  if (trimmedKey === "") {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs">
      {t("templates.fieldLookupFormatMarker")}
      <code className="bg-muted ms-1 rounded px-1 py-0.5">
        {`{{${fieldPath}.${trimmedKey}}}`}
      </code>
    </p>
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
  field: TemplateEditableField;
  onUpdate: (patch: Partial<TemplateEditableField>) => void;
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
  field: TemplateEditableField;
  onUpdate: (patch: Partial<TemplateEditableField>) => void;
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
                  ? {
                      formula: field.formula ?? "",
                      lookup: undefined,
                      source: undefined,
                    }
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
                dir="ltr"
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

type BindingCatalogResponse = Awaited<
  ReturnType<(typeof api.templates)["binding-catalog"]["get"]>
>;

type BindingCatalogData = Exclude<
  NonNullable<Extract<BindingCatalogResponse, { data: unknown }>["data"]>,
  Response
>;

/** One pickable source in the binding catalog (the matter's client, a party, the
 *  matter, an attorney, or the firm), with its bindable fields and any extra
 *  selector (party `roles`, attorney `refs`). Derived from the Eden response so
 *  it tracks the backend catalog. */
type CatalogSource = BindingCatalogData["sources"][number];

/** Compose a {@link FieldSource} from a catalog source plus the role/ref the
 *  author picked. Explicit per-branch construction so each variant carries
 *  exactly the keys it needs: party adds `role`, attorney adds `ref`, the rest
 *  carry only `field`. */
const composeSource = (
  source: CatalogSource,
  fieldKey: string,
  role: string,
  ref: string,
): FieldSource => {
  switch (source.kind) {
    case "contact":
      return { kind: "contact", field: fieldKey };
    case "party":
      return { kind: "party", role, field: fieldKey };
    case "matter":
      return { kind: "matter", field: fieldKey };
    case "attorney":
      return { kind: "attorney", ref, field: fieldKey };
    case "firm":
      return { kind: "firm", field: fieldKey };
    default: {
      // A new source kind must be handled explicitly rather than silently
      // persisting as a contact binding.
      source satisfies never;
      return panic(`Unhandled source: ${String(source)}`);
    }
  }
};

/** The source selected by default when a source is first enabled or switched:
 *  its first field, and (where applicable) its first role/ref. */
const defaultSourceFor = (source: CatalogSource): FieldSource =>
  composeSource(
    source,
    source.fields.at(0)?.key ?? "",
    source.kind === "party" ? (source.roles.at(0)?.value ?? "") : "",
    source.kind === "attorney" ? (source.refs.at(0)?.value ?? "") : "",
  );

/** Binding-source affordance: the field's value is resolved server-side from a
 *  matter record at fill time, so the fill form asks for nothing. The pickable
 *  sources and fields come from the binding catalog. Mutually exclusive with the
 *  other value sources; enabling it clears the registry lookup and formula
 *  configuration. */
const BindingSourceConfigControl = ({
  field,
  onUpdate,
}: {
  field: EditableField;
  onUpdate: (patch: Partial<EditableField>) => void;
}) => {
  const t = useTranslations();
  const { data } = useQuery(bindingCatalogOptions());
  const sources = optionalArray(data?.sources);
  const firstSource = sources.at(0);

  // A binding is a derived value source, mutually exclusive with every other
  // input mode; enabling it clears them all (matching the Studio's value-source
  // switcher, which clears aiPrompt/aiAdapt/aiSeesDocument together) so a field
  // never carries a binding beside a rival the backend validator rejects.
  const emitSource = (source: FieldSource) =>
    onUpdate({
      source,
      lookup: undefined,
      formula: undefined,
      optionsFrom: undefined,
      dateFormat: undefined,
      condition: undefined,
      conditionAst: undefined,
      aiPrompt: undefined,
      aiAdapt: false,
      aiSeesDocument: false,
    });

  // Fail safe: while the catalog is loading or errored there is nothing to
  // bind to, so the toggle is disabled rather than crashing on empty data.
  if (firstSource === undefined) {
    return (
      <Field>
        <div className="flex items-center gap-2">
          <Checkbox checked={field.source !== undefined} disabled />
          <FieldLabel>{t("templates.studio.sourceEnable")}</FieldLabel>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("templates.studio.sourceHint")}
        </p>
      </Field>
    );
  }

  return (
    <>
      <Field>
        <div className="flex items-center gap-2">
          <Checkbox
            checked={field.source !== undefined}
            onCheckedChange={(checked) =>
              checked
                ? emitSource(defaultSourceFor(firstSource))
                : onUpdate({ source: undefined })
            }
          />
          <FieldLabel>{t("templates.studio.sourceEnable")}</FieldLabel>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("templates.studio.sourceHint")}
        </p>
      </Field>

      {field.source !== undefined && (
        <BindingSourcePicker
          onChange={emitSource}
          source={field.source}
          sources={sources}
        />
      )}
    </>
  );
};

/** Cascading selects that compose a {@link FieldSource}: pick the source, then
 *  its role (party) or attorney ref (attorney) where the source has them, then
 *  the bindable field. Switching the source reseeds the field (and role/ref) to
 *  the new source's defaults since the field set differs per source. */
const BindingSourcePicker = ({
  source,
  sources,
  onChange,
}: {
  source: FieldSource;
  sources: readonly CatalogSource[];
  onChange: (next: FieldSource) => void;
}) => {
  const t = useTranslations();
  const selected = sources.find((s) => s.kind === source.kind) ?? sources.at(0);
  if (selected === undefined) {
    return null;
  }

  const role = source.kind === "party" ? source.role : "";
  const ref = source.kind === "attorney" ? source.ref : "";

  return (
    <>
      <Field>
        <FieldLabel>{t("templates.studio.sourcePickSource")}</FieldLabel>
        <Select
          onValueChange={(val) => {
            const next = sources.find((s) => s.kind === val);
            if (next !== undefined) {
              onChange(defaultSourceFor(next));
            }
          }}
          value={selected.kind}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {sources.map((s) => (
              <SelectItem key={s.kind} value={s.kind}>
                {t(s.labelKey)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>

      {selected.kind === "party" && source.kind === "party" && (
        <Field>
          <FieldLabel>{t("common.role")}</FieldLabel>
          <Select
            onValueChange={(val) => {
              if (typeof val === "string") {
                onChange({ kind: "party", role: val, field: source.field });
              }
            }}
            value={source.role}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {selected.roles.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {t(r.labelKey)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      )}

      {selected.kind === "attorney" && source.kind === "attorney" && (
        <Field>
          <FieldLabel>{t("templates.binding.sourceAttorney")}</FieldLabel>
          <Select
            onValueChange={(val) => {
              if (typeof val === "string") {
                onChange({ kind: "attorney", ref: val, field: source.field });
              }
            }}
            value={source.ref}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {selected.refs.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {t(r.labelKey)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      )}

      <Field>
        <FieldLabel>{t("templates.conditionField")}</FieldLabel>
        <Select
          onValueChange={(val) => {
            if (typeof val === "string") {
              onChange(composeSource(selected, val, role, ref));
            }
          }}
          value={source.field}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {selected.fields.map((f) => (
              <SelectItem key={f.key} value={f.key}>
                {t(f.labelKey)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
    </>
  );
};

/** Hint length cap mirrored by the manifest's expectation of short hints. */
const HINT_MAX_LENGTH = 200;

export const FieldConfigEditor = ({
  field,
  onUpdate,
  embedded = false,
  hideHint = false,
  hideRequired = false,
  siblingPaths,
  hideFormulaControl = false,
  hideSourceControl = false,
  defaultDateLocale,
}: {
  field: TemplateEditableField;
  onUpdate: (patch: Partial<TemplateEditableField>) => void;
  /** Embedded in the Studio's field face: the face header already shows the
   *  path, and the wizard's chevron-row indent doesn't apply. */
  embedded?: boolean;
  /** Hide the fill-form hint input (AI-drafted fields have no question). */
  hideHint?: boolean;
  /** Hide the "required" toggle — no person fills an AI-drafted field, so
   *  requiredness is meaningless there (formula fields drop it too). */
  hideRequired?: boolean;
  /** Paths of the template's other fields, offered as sources for a
   *  dependent select's options; a typed path input is shown when absent. */
  siblingPaths?: readonly string[] | undefined;
  /** The host renders its own formula affordance (the Studio's source
   *  picker); drop the built-in control to avoid duplicating it. */
  hideFormulaControl?: boolean;
  /** Hide the data-binding affordance. Set for a field inside a `{% for %}`
   *  repeat block: the backend resolver leaves loop-item paths unresolved, so
   *  a binding there would silently produce nothing. */
  hideSourceControl?: boolean;
  /** Preselected locale for a date field's format picker — the template's
   *  primary language when the host knows it; app locale otherwise. */
  defaultDateLocale?: string | undefined;
}) => {
  const t = useTranslations();
  const appLocale = useLocale();
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
        <div className="flex items-center justify-between gap-2">
          <FieldLabel>{t("templates.fieldLabel")}</FieldLabel>
          {isFormula || hideRequired ? null : (
            <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
              <Checkbox
                checked={field.required}
                onCheckedChange={(checked) => onUpdate({ required: checked })}
              />
              {t("common.required")}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </label>
          )}
        </div>
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

      {!isFormula && !hideHint && (
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
          <FieldLabel>{t("templates.fieldInputType")}</FieldLabel>
          <Select
            onValueChange={(val) => {
              if (val === "company") {
                // "company" maps to inputType "text" + lookup (see
                // FIELD_TYPE_CHOICES); keep an existing lookup config.
                const seedRegistry = preferredRegistry(appLocale);
                onUpdate({
                  inputType: "text",
                  source: undefined,
                  lookup: field.lookup ?? {
                    registry: seedRegistry,
                    formats: [
                      {
                        key: LOOKUP_DEFAULT_FORMAT_KEY,
                        template: REGISTRY_DEFAULT_FORMAT[seedRegistry],
                      },
                    ],
                  },
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

      {!hideFormulaControl && typeChoice !== "company" && (
        <FormulaConfigControl field={field} onUpdate={onUpdate} />
      )}

      {!hideSourceControl && typeChoice !== "company" && (
        <BindingSourceConfigControl field={field} onUpdate={onUpdate} />
      )}

      {!isFormula && typeChoice === "company" && (
        <CompanyLookupConfig field={field} onUpdate={onUpdate} />
      )}

      {!isFormula && typeChoice === "date" && (
        <DateFormatConfigControl
          defaultLocale={defaultDateLocale ?? appLocale}
          field={field}
          onUpdate={onUpdate}
        />
      )}

      {!isFormula && field.inputType === "select" && (
        <>
          <Field>
            <FieldLabel>{t("common.options")}</FieldLabel>
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
