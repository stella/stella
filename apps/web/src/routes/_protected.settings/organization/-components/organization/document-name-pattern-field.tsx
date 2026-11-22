import { useTranslations } from "use-intl";

import { renderDocumentName } from "@stll/api-contract/document-name";
import { Field, FieldDescription, FieldLabel } from "@stll/ui/field";
import { Input } from "@stll/ui/input";

import { MatterNumberPreview } from "./matter-numbering-card.pending";

const EXAMPLE_PATTERN = "{date}_{matterNumber}_{docType}_{title}";

type DocumentNamePatternFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** Why the pattern cannot be saved, or null. */
  problem: string | null;
};

/**
 * The pattern new uploads are renamed to in matters that opt in, with the
 * name a signed contract would get. Empty keeps uploaded names.
 */
export const DocumentNamePatternField = ({
  onChange,
  problem,
  value,
}: DocumentNamePatternFieldProps) => {
  const t = useTranslations();
  const sample =
    value === "" || problem !== null
      ? null
      : renderDocumentName({
          pattern: value,
          values: {
            date: "2026-03-14",
            matterNumber: "2026-042",
            docType: t("organization.documentNaming.sampleDocType"),
            title: t("organization.documentNaming.sampleTitle"),
          },
          extension: ".pdf",
        });

  return (
    <>
      <Field>
        <FieldLabel>{t("organization.documentNaming.pattern")}</FieldLabel>
        <Input
          onChange={(event) => onChange(event.target.value)}
          placeholder={EXAMPLE_PATTERN}
          value={value}
        />
        <FieldDescription>
          {t("organization.documentNaming.description")}
        </FieldDescription>
        <p className="text-muted-foreground text-xs">
          {t("organization.documentNaming.tokenHelp")}
        </p>
      </Field>
      {problem !== null && (
        <p role="alert" className="text-destructive text-xs">
          {t("organization.documentNaming.invalid")}
        </p>
      )}
      {sample !== null && (
        <MatterNumberPreview label={t("organization.documentNaming.preview")}>
          {sample}
        </MatterNumberPreview>
      )}
    </>
  );
};
