import type { PropsWithChildren } from "react";

import { useTranslations } from "use-intl";

import { Checkbox } from "@stll/ui/components/checkbox";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/components/tabs";

import type {
  NumberedParagraphStyleSettings,
  ParagraphStyleSettings,
  StyleSetEditorSettings,
} from "@/features/style-sets/style-set-editor-types";

const POINTS_TRANSLATION_KEY = "styleSets.editor.points";
const LOWER_LETTER_NUMBERING_SAMPLE = "(a)";
const LOWER_ROMAN_NUMBERING_SAMPLE = "(i)";
const UPPER_LETTER_NUMBERING_SAMPLE = "(A)";

export const StyleSetEditorControls = ({
  settings,
  onChange,
}: {
  settings: StyleSetEditorSettings;
  onChange: (settings: StyleSetEditorSettings) => void;
}) => {
  const t = useTranslations();

  return (
    <Tabs className="flex min-h-0 flex-1 flex-col" defaultValue="typography">
      <TabsList className="mx-5 mt-4" variant="underline">
        <TabsTab value="typography">{t("styleSets.editor.typography")}</TabsTab>
        <TabsTab value="numbering">{t("styleSets.editor.numbering")}</TabsTab>
        <TabsTab value="page">{t("styleSets.editor.page")}</TabsTab>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <TabsPanel value="typography">
          <div className="space-y-6 pt-4">
            <ControlSection title={t("styleSets.editor.bodyText")}>
              <FontField
                id="style-set-body-font"
                onChange={(fontFamily) =>
                  onChange({
                    ...settings,
                    body: { ...settings.body, fontFamily },
                  })
                }
                value={settings.body.fontFamily}
              />
              <NumberField
                id="style-set-body-size"
                label={t("folio.fontSize")}
                max={400}
                min={1}
                onChange={(fontSizePt) =>
                  onChange({
                    ...settings,
                    body: { ...settings.body, fontSizePt },
                  })
                }
                suffix={t(POINTS_TRANSLATION_KEY)}
                step={0.5}
                value={settings.body.fontSizePt}
              />
              <AlignmentField
                id="style-set-body-alignment"
                onChange={(alignment) =>
                  onChange({
                    ...settings,
                    body: { ...settings.body, alignment },
                  })
                }
                value={settings.body.alignment}
              />
              <LineSpacingField
                id="style-set-body-line-spacing"
                onChange={(lineSpacing) =>
                  onChange({
                    ...settings,
                    body: { ...settings.body, lineSpacing },
                  })
                }
                value={settings.body.lineSpacing}
              />
              <NumberField
                id="style-set-body-after"
                label={t("styleSets.editor.spaceAfter")}
                max={1440}
                min={0}
                onChange={(spaceAfterPt) =>
                  onChange({
                    ...settings,
                    body: { ...settings.body, spaceAfterPt },
                  })
                }
                suffix={t(POINTS_TRANSLATION_KEY)}
                value={settings.body.spaceAfterPt}
              />
            </ControlSection>
            <ParagraphStyleSection
              id="title"
              onChange={(title) => onChange({ ...settings, title })}
              title={t("clauses.titleLabel")}
              value={settings.title}
            />
            <ParagraphStyleSection
              id="level-1"
              onChange={(level1) => onChange({ ...settings, level1 })}
              title={t("styleSets.editor.level1")}
              value={settings.level1}
            />
            <ParagraphStyleSection
              id="level-2"
              onChange={(level2) => onChange({ ...settings, level2 })}
              title={t("styleSets.editor.level2")}
              value={settings.level2}
            />
            <ParagraphStyleSection
              id="level-3"
              onChange={(level3) => onChange({ ...settings, level3 })}
              title={t("styleSets.editor.level3")}
              value={settings.level3}
            />
          </div>
        </TabsPanel>
        <TabsPanel value="numbering">
          <div className="space-y-6 pt-4">
            <Field className="flex-row items-center gap-3 rounded-lg border p-3">
              <Checkbox
                checked={settings.numbering.enabled}
                id="style-set-numbering-enabled"
                onCheckedChange={(enabled) =>
                  onChange({
                    ...settings,
                    numbering: { enabled },
                  })
                }
              />
              <div>
                <FieldLabel htmlFor="style-set-numbering-enabled">
                  {t("styleSets.editor.numberingEnabled")}
                </FieldLabel>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t("styleSets.editor.numberingDescription")}
                </p>
              </div>
            </Field>
            <NumberingLevelSection
              disabled={!settings.numbering.enabled}
              id="numbering-level-1"
              onChange={(level1) => onChange({ ...settings, level1 })}
              title={t("styleSets.editor.level1")}
              value={settings.level1}
            />
            <NumberingLevelSection
              disabled={!settings.numbering.enabled}
              id="numbering-level-2"
              onChange={(level2) => onChange({ ...settings, level2 })}
              title={t("styleSets.editor.level2")}
              value={settings.level2}
            />
            <NumberingLevelSection
              disabled={!settings.numbering.enabled}
              id="numbering-level-3"
              onChange={(level3) => onChange({ ...settings, level3 })}
              title={t("styleSets.editor.level3")}
              value={settings.level3}
            />
          </div>
        </TabsPanel>
        <TabsPanel value="page">
          <div className="space-y-6 pt-4">
            <ControlSection title={t("styleSets.editor.paper")}>
              <PaperSizeField
                id="style-set-paper-size"
                onChange={(paperSize) =>
                  onChange({
                    ...settings,
                    page: { ...settings.page, paperSize },
                  })
                }
                value={settings.page.paperSize}
              />
              <OrientationField
                id="style-set-orientation"
                onChange={(orientation) =>
                  onChange({
                    ...settings,
                    page: { ...settings.page, orientation },
                  })
                }
                value={settings.page.orientation}
              />
            </ControlSection>
            <ControlSection title={t("styleSets.editor.margins")}>
              <NumberField
                id="style-set-margin-top"
                label={t("styleSets.editor.marginTop")}
                max={1440}
                min={0}
                onChange={(marginTopPt) =>
                  onChange({
                    ...settings,
                    page: { ...settings.page, marginTopPt },
                  })
                }
                suffix={t(POINTS_TRANSLATION_KEY)}
                value={settings.page.marginTopPt}
              />
              <NumberField
                id="style-set-margin-bottom"
                label={t("styleSets.editor.marginBottom")}
                max={1440}
                min={0}
                onChange={(marginBottomPt) =>
                  onChange({
                    ...settings,
                    page: { ...settings.page, marginBottomPt },
                  })
                }
                suffix={t(POINTS_TRANSLATION_KEY)}
                value={settings.page.marginBottomPt}
              />
              <NumberField
                id="style-set-margin-start"
                label={t("styleSets.editor.marginLeft")}
                max={1440}
                min={0}
                onChange={(marginLeftPt) =>
                  onChange({
                    ...settings,
                    page: { ...settings.page, marginLeftPt },
                  })
                }
                suffix={t(POINTS_TRANSLATION_KEY)}
                value={settings.page.marginLeftPt}
              />
              <NumberField
                id="style-set-margin-end"
                label={t("styleSets.editor.marginRight")}
                max={1440}
                min={0}
                onChange={(marginRightPt) =>
                  onChange({
                    ...settings,
                    page: { ...settings.page, marginRightPt },
                  })
                }
                suffix={t(POINTS_TRANSLATION_KEY)}
                value={settings.page.marginRightPt}
              />
            </ControlSection>
          </div>
        </TabsPanel>
      </div>
    </Tabs>
  );
};

const ControlSection = ({
  title,
  children,
}: PropsWithChildren<{ title: string }>) => (
  <section className="space-y-3">
    <h3 className="text-sm font-semibold">{title}</h3>
    <div className="grid grid-cols-2 gap-3">{children}</div>
  </section>
);

const ParagraphStyleSection = <TStyle extends ParagraphStyleSettings>({
  id,
  title,
  value,
  onChange,
}: {
  id: string;
  title: string;
  value: TStyle;
  onChange: (value: TStyle) => void;
}) => (
  <ControlSection title={title}>
    <FontField
      id={`${id}-font`}
      onChange={(fontFamily) => onChange({ ...value, fontFamily })}
      value={value.fontFamily}
    />
    <StyleSizeField
      id={`${id}-size`}
      onChange={(fontSizePt) => onChange({ ...value, fontSizePt })}
      value={value.fontSizePt}
    />
    <BoldField
      id={`${id}-bold`}
      onChange={(bold) => onChange({ ...value, bold })}
      value={value.bold}
    />
    <AlignmentField
      id={`${id}-alignment`}
      onChange={(alignment) => onChange({ ...value, alignment })}
      value={value.alignment}
    />
    <SpacingFields
      id={id}
      onSpaceAfterChange={(spaceAfterPt) =>
        onChange({ ...value, spaceAfterPt })
      }
      onSpaceBeforeChange={(spaceBeforePt) =>
        onChange({ ...value, spaceBeforePt })
      }
      spaceAfterPt={value.spaceAfterPt}
      spaceBeforePt={value.spaceBeforePt}
    />
  </ControlSection>
);

const NumberingLevelSection = ({
  id,
  title,
  value,
  disabled,
  onChange,
}: {
  id: string;
  title: string;
  value: NumberedParagraphStyleSettings;
  disabled: boolean;
  onChange: (value: NumberedParagraphStyleSettings) => void;
}) => (
  <fieldset className="space-y-3 disabled:opacity-50" disabled={disabled}>
    <legend className="text-sm font-semibold">{title}</legend>
    <div className="grid grid-cols-2 gap-3">
      <NumberingFormatField
        id={`${id}-format`}
        onChange={(numberingFormat) => onChange({ ...value, numberingFormat })}
        value={value.numberingFormat}
      />
      <NumberField
        id={`${id}-indent`}
        labelKey="styleSets.editor.indent"
        max={1440}
        min={0}
        onChange={(indentLeftPt) => onChange({ ...value, indentLeftPt })}
        suffixKey={POINTS_TRANSLATION_KEY}
        value={value.indentLeftPt}
      />
      <NumberField
        id={`${id}-hanging`}
        labelKey="styleSets.editor.hanging"
        max={1440}
        min={0}
        onChange={(hangingPt) => onChange({ ...value, hangingPt })}
        suffixKey={POINTS_TRANSLATION_KEY}
        value={value.hangingPt}
      />
    </div>
  </fieldset>
);

const FontField = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) => {
  const t = useTranslations();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("styleSets.editor.fontFamily")}</FieldLabel>
      <Input
        id={id}
        maxLength={128}
        onChange={(event) => onChange(event.currentTarget.value)}
        required
        value={value}
      />
    </Field>
  );
};

type NumberFieldProps = {
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
} & (
  | { label: string; suffix: string; labelKey?: never; suffixKey?: never }
  | {
      labelKey: "styleSets.editor.indent" | "styleSets.editor.hanging";
      suffixKey: typeof POINTS_TRANSLATION_KEY;
      label?: never;
      suffix?: never;
    }
);

const NumberField = ({
  id,
  value,
  min,
  max,
  step,
  onChange,
  label,
  suffix,
  labelKey,
  suffixKey,
}: NumberFieldProps) => {
  const t = useTranslations();
  const resolvedStep = step ?? 0.25;
  const resolvedLabel = labelKey ? t(labelKey) : label;
  const resolvedSuffix = suffixKey ? t(suffixKey) : suffix;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{resolvedLabel}</FieldLabel>
      <div className="relative w-full">
        <Input
          className="pe-9 tabular-nums"
          dir="ltr"
          id={id}
          max={max}
          min={min}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (Number.isFinite(next) && next >= min && next <= max) {
              onChange(next);
            } else if (event.currentTarget.value === "") {
              onChange(min);
            }
          }}
          step={resolvedStep}
          type="number"
          value={value}
        />
        <span className="text-muted-foreground pointer-events-none absolute inset-y-0 end-2 flex items-center text-xs">
          {resolvedSuffix}
        </span>
      </div>
    </Field>
  );
};

const StyleSizeField = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
}) => {
  const t = useTranslations();
  return (
    <NumberField
      id={id}
      label={t("folio.fontSize")}
      max={400}
      min={1}
      onChange={onChange}
      step={0.5}
      suffix={t(POINTS_TRANSLATION_KEY)}
      value={value}
    />
  );
};

const BoldField = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) => {
  const t = useTranslations();
  return (
    <Field className="flex-row items-center gap-2 self-end pb-2">
      <Checkbox checked={value} id={id} onCheckedChange={onChange} />
      <FieldLabel htmlFor={id}>{t("folio.bold")}</FieldLabel>
    </Field>
  );
};

const SpacingFields = ({
  id,
  spaceBeforePt,
  spaceAfterPt,
  onSpaceBeforeChange,
  onSpaceAfterChange,
}: {
  id: string;
  spaceBeforePt: number;
  spaceAfterPt: number;
  onSpaceBeforeChange: (value: number) => void;
  onSpaceAfterChange: (value: number) => void;
}) => {
  const t = useTranslations();
  return (
    <>
      <NumberField
        id={`${id}-before`}
        label={t("styleSets.editor.spaceBefore")}
        max={1440}
        min={0}
        onChange={onSpaceBeforeChange}
        suffix={t(POINTS_TRANSLATION_KEY)}
        value={spaceBeforePt}
      />
      <NumberField
        id={`${id}-after`}
        label={t("styleSets.editor.spaceAfter")}
        max={1440}
        min={0}
        onChange={onSpaceAfterChange}
        suffix={t(POINTS_TRANSLATION_KEY)}
        value={spaceAfterPt}
      />
    </>
  );
};

const AlignmentField = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ParagraphStyleSettings["alignment"];
  onChange: (value: ParagraphStyleSettings["alignment"]) => void;
}) => {
  const t = useTranslations();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("folio.alignmentGroup")}</FieldLabel>
      <Select
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onChange(nextValue);
          }
        }}
        value={value}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="preserve">
            {t("styleSets.editor.preserve")}
          </SelectItem>
          <SelectItem value="left">{t("folio.alignLeft")}</SelectItem>
          <SelectItem value="center">{t("folio.alignCenter")}</SelectItem>
          <SelectItem value="right">{t("folio.alignRight")}</SelectItem>
          <SelectItem value="both">{t("folio.justify")}</SelectItem>
        </SelectPopup>
      </Select>
    </Field>
  );
};

const LineSpacingField = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: StyleSetEditorSettings["body"]["lineSpacing"];
  onChange: (value: StyleSetEditorSettings["body"]["lineSpacing"]) => void;
}) => {
  const t = useTranslations();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("styleSets.editor.lineSpacing")}</FieldLabel>
      <Select
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onChange(nextValue);
          }
        }}
        value={value}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="preserve">
            {t("styleSets.editor.preserve")}
          </SelectItem>
          <SelectItem value="single">{t("styleSets.editor.single")}</SelectItem>
          <SelectItem value="onePoint15">1.15</SelectItem>
          <SelectItem value="onePoint5">1.5</SelectItem>
          <SelectItem value="double">{t("styleSets.editor.double")}</SelectItem>
        </SelectPopup>
      </Select>
    </Field>
  );
};

const NumberingFormatField = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: NumberedParagraphStyleSettings["numberingFormat"];
  onChange: (value: NumberedParagraphStyleSettings["numberingFormat"]) => void;
}) => {
  const t = useTranslations();
  return (
    <Field className="col-span-2">
      <FieldLabel htmlFor={id}>{t("styleSets.editor.numberFormat")}</FieldLabel>
      <Select
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onChange(nextValue);
          }
        }}
        value={value}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="preserve">
            {t("styleSets.editor.preserveCustom")}
          </SelectItem>
          <SelectItem value="decimal">1</SelectItem>
          <SelectItem value="hierarchicalDecimal">1.1.1</SelectItem>
          <SelectItem value="lowerLetterParenthetical">
            {LOWER_LETTER_NUMBERING_SAMPLE}
          </SelectItem>
          <SelectItem value="lowerRomanParenthetical">
            {LOWER_ROMAN_NUMBERING_SAMPLE}
          </SelectItem>
          <SelectItem value="upperLetterParenthetical">
            {UPPER_LETTER_NUMBERING_SAMPLE}
          </SelectItem>
          <SelectItem value="upperRoman">I</SelectItem>
        </SelectPopup>
      </Select>
    </Field>
  );
};

const PaperSizeField = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: StyleSetEditorSettings["page"]["paperSize"];
  onChange: (value: StyleSetEditorSettings["page"]["paperSize"]) => void;
}) => {
  const t = useTranslations();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("styleSets.editor.paperSize")}</FieldLabel>
      <Select
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onChange(nextValue);
          }
        }}
        value={value}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="preserve">
            {t("styleSets.editor.preserveCustom")}
          </SelectItem>
          <SelectItem value="a4">A4</SelectItem>
          <SelectItem value="letter">{t("styleSets.editor.letter")}</SelectItem>
          <SelectItem value="legal">{t("styleSets.editor.legal")}</SelectItem>
        </SelectPopup>
      </Select>
    </Field>
  );
};

const OrientationField = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: StyleSetEditorSettings["page"]["orientation"];
  onChange: (value: StyleSetEditorSettings["page"]["orientation"]) => void;
}) => {
  const t = useTranslations();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("styleSets.editor.orientation")}</FieldLabel>
      <Select
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onChange(nextValue);
          }
        }}
        value={value}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="portrait">
            {t("styleSets.editor.portrait")}
          </SelectItem>
          <SelectItem value="landscape">
            {t("styleSets.editor.landscape")}
          </SelectItem>
        </SelectPopup>
      </Select>
    </Field>
  );
};
