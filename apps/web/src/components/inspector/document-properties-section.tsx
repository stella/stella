import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type {
  DocumentPropertiesResult,
  DocumentPropertyKey,
  DocumentPropertyValue,
} from "@stll/api-contract";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { documentPropertiesOptions } from "@/lib/files/queries";
import { formatFullTimestamp } from "@/lib/relative-time";

/**
 * Labels for the properties a file records about itself. Total over the
 * contract's key list, so a key added on the server fails this typecheck
 * instead of rendering as a blank row.
 */
const PROPERTY_LABEL_KEYS = {
  title: "common.documentTitle",
  subject: "inspector.metadata.documentProperties.keys.subject",
  description: "common.description",
  keywords: "inspector.metadata.documentProperties.keys.keywords",
  category: "common.category",
  contentStatus: "inspector.metadata.documentProperties.keys.contentStatus",
  author: "inspector.metadata.documentProperties.keys.author",
  lastModifiedBy: "inspector.metadata.documentProperties.keys.lastModifiedBy",
  company: "inspector.metadata.documentProperties.keys.company",
  manager: "inspector.metadata.documentProperties.keys.manager",
  createdAt: "inspector.metadata.documentProperties.keys.createdAt",
  modifiedAt: "inspector.metadata.documentProperties.keys.modifiedAt",
  lastPrintedAt: "inspector.metadata.documentProperties.keys.lastPrintedAt",
  revision: "inspector.metadata.documentProperties.keys.revision",
  editingMinutes: "inspector.metadata.documentProperties.keys.editingMinutes",
  application: "inspector.metadata.documentProperties.keys.application",
  applicationVersion:
    "inspector.metadata.documentProperties.keys.applicationVersion",
  producer: "inspector.metadata.documentProperties.keys.producer",
  template: "inspector.metadata.documentProperties.keys.template",
  language: "common.language",
  pages: "inspector.metadata.documentProperties.keys.pages",
  words: "inspector.metadata.documentProperties.keys.words",
  characters: "inspector.metadata.documentProperties.keys.characters",
  paragraphs: "inspector.metadata.documentProperties.keys.paragraphs",
  slides: "inspector.metadata.documentProperties.keys.slides",
} as const satisfies Record<DocumentPropertyKey, TranslationKey>;

/**
 * Why there is nothing to show. Each reason gets its own sentence: "this
 * format has no properties" and "we could not read them" mean different
 * things to someone checking a document's provenance.
 */
const UNAVAILABLE_MESSAGE_KEYS = {
  "unsupported-format":
    "inspector.metadata.documentProperties.unsupportedFormat",
  "password-protected":
    "inspector.metadata.documentProperties.passwordProtected",
  "too-large": "inspector.metadata.documentProperties.tooLarge",
  unreadable: "inspector.metadata.documentProperties.unreadable",
} as const satisfies Record<
  Exclude<DocumentPropertiesResult["status"], "available">,
  TranslationKey
>;

type DocumentPropertiesSectionProps = {
  workspaceId: string;
  fileFieldId: string;
};

/**
 * The metadata the file itself carries, read from the stored bytes: what Word
 * or the PDF producer wrote into it, not what stella or AI added afterwards.
 */
export const DocumentPropertiesSection = ({
  workspaceId,
  fileFieldId,
}: DocumentPropertiesSectionProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const { data, isPending, isError } = useQuery(
    documentPropertiesOptions({ workspaceId, fieldId: fileFieldId }),
  );

  if (isPending) {
    return <Message>{t("common.loading")}</Message>;
  }
  if (isError) {
    return <Message>{t("common.somethingWentWrong")}</Message>;
  }
  if (data.status !== "available") {
    return <Message>{t(UNAVAILABLE_MESSAGE_KEYS[data.status])}</Message>;
  }
  if (data.properties.length === 0) {
    return (
      <Message>{t("inspector.metadata.documentProperties.empty")}</Message>
    );
  }

  const renderValue = (value: DocumentPropertyValue): string => {
    switch (value.type) {
      case "text":
        return value.value;
      case "date":
        return formatFullTimestamp(value.value);
      case "count":
        return format.number(value.value);
      case "minutes":
        // Intl's `minute` unit carries the locale's own plural rules and
        // spacing, so the duration needs no translated string of its own.
        return format.number(value.value, {
          style: "unit",
          unit: "minute",
          unitDisplay: "long",
        });
      default:
        return value satisfies never;
    }
  };

  return (
    <div className="flex flex-col gap-px px-2 pb-2">
      {data.properties.map((property) => (
        <div
          className="flex flex-col gap-1 rounded-md px-2 py-2"
          key={property.key}
        >
          <span className="text-muted-foreground text-xs font-medium">
            {t(PROPERTY_LABEL_KEYS[property.key])}
          </span>
          <span className="text-foreground text-sm break-words">
            {renderValue(property.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

const Message = ({ children }: { children: string }) => (
  <div className="px-4 py-4">
    <span className="text-muted-foreground text-sm">{children}</span>
  </div>
);
