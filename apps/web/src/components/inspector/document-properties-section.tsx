import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  type AuthoredDocumentPropertyKey,
  DOCUMENT_PROPERTY_KEYS,
  type DocumentPropertiesResult,
  type DocumentPropertyKey,
  type DocumentPropertyValue,
  isAuthoredDocumentPropertyKey,
} from "@stll/api-contract";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { documentPropertiesQueryKey } from "@/lib/files/file-metadata-query.logic";
import {
  documentPropertiesOptions,
  updateDocumentProperty,
} from "@/lib/files/queries";
import { formatFullTimestamp } from "@/lib/relative-time";

/**
 * Labels for the properties a file records about itself. Total over the
 * contract's key list, so a key added on the server fails this typecheck
 * instead of rendering as a blank row.
 */
const PROPERTY_LABEL_KEYS = {
  title: "inspector.metadata.documentProperties.keys.title",
  subject: "inspector.metadata.documentProperties.keys.subject",
  description: "inspector.metadata.documentProperties.keys.description",
  keywords: "inspector.metadata.documentProperties.keys.keywords",
  category: "common.category",
  contentStatus: "inspector.metadata.documentProperties.keys.contentStatus",
  author: "common.author",
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

/**
 * A rendered row, split by whether the reader can change it. Carrying that in
 * the row rather than re-deriving it at render keeps one decision in one place:
 * a generated fact like the total editing time has no writable home in the
 * file, so it must never be handed to a text box that implies it does.
 */
type PropertyRow =
  | { kind: "editable"; key: AuthoredDocumentPropertyKey; value: string }
  | {
      kind: "readonly";
      key: DocumentPropertyKey;
      value: DocumentPropertyValue;
    };

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
  const [isAllOpen, setIsAllOpen] = useState(false);
  const { data, isPending, isError } = useQuery(
    documentPropertiesOptions({
      workspaceId,
      fieldId: fileFieldId,
    }),
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
  // A writable file with nothing filled in is not an empty state: the blank
  // fields are the whole point, since they are the ones you came here to fill.
  if (data.properties.length === 0 && !data.editable) {
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
        value satisfies never;
        return panic(`Unhandled value: ${String(value)}`);
    }
  };

  const valueByKey = new Map(
    data.properties.map((property) => [property.key, property.value] as const),
  );

  const rows: PropertyRow[] = [];
  for (const key of DOCUMENT_PROPERTY_KEYS) {
    // Folded into `application` below: on its own, a build number is a row that
    // answers a question nobody asked.
    if (key === "applicationVersion") {
      continue;
    }
    const value =
      key === "application"
        ? applicationWithVersion(valueByKey)
        : valueByKey.get(key);

    if (data.editable && isAuthoredDocumentPropertyKey(key)) {
      // Authored fields render even when blank. An empty Author is exactly the
      // case worth fixing, and a field you cannot see is a field you cannot fill.
      rows.push({
        kind: "editable",
        key,
        value: value?.type === "text" ? value.value : "",
      });
      continue;
    }
    if (value !== undefined) {
      rows.push({ kind: "readonly", key, value });
    }
  }

  const headline = rows.filter(isHeadlineRow);
  const rest = rows.filter((candidate) => !isHeadlineRow(candidate));

  const row = (property: PropertyRow) => (
    <div
      className="flex flex-col gap-1 rounded-md px-2 py-2"
      key={property.key}
    >
      <span className="text-muted-foreground text-xs font-medium">
        {t(PROPERTY_LABEL_KEYS[property.key])}
      </span>
      {property.kind === "editable" ? (
        <EditablePropertyValue
          fileFieldId={fileFieldId}
          label={t(PROPERTY_LABEL_KEYS[property.key])}
          propertyKey={property.key}
          value={property.value}
          workspaceId={workspaceId}
        />
      ) : (
        <span className="text-foreground text-sm wrap-break-word">
          {renderValue(property.value)}
        </span>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-px px-2 pb-2">
      {headline.map((property) => row(property))}
      {rest.length > 0 && (
        <details
          className="group/all"
          onToggle={(event) => setIsAllOpen(event.currentTarget.open)}
          open={isAllOpen}
        >
          <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 rounded-md px-2 py-2 text-xs font-medium">
            <DirectionalIcon
              className="size-3 shrink-0 transition-transform group-open/all:rotate-90"
              flip={!isAllOpen}
              icon={ChevronRightIcon}
            />
            {t("common.showAll")}
          </summary>
          {rest.map((property) => row(property))}
        </details>
      )}
    </div>
  );
};

/**
 * Shown without asking, because they are what someone opening the tab came for:
 * who the document says wrote it and which organisation it says produced it.
 * Everything else, including the generated facts, lives under the disclosure —
 * "0 words" from a generator that never recomputed its counters is noise until
 * you deliberately go looking for it.
 */
const isHeadlineRow = (property: PropertyRow): boolean =>
  property.key === "author" || property.key === "company";

/**
 * Word writes one fact as two properties: `Application` ("Microsoft Office
 * Word") and `AppVersion` ("16.0000"). Joined, the version qualifies the name
 * it belongs to; split across two rows, it is a bare build number sitting under
 * its own heading. Dropped entirely when the name is missing, since a version
 * with nothing to version is noise.
 */
const applicationWithVersion = (
  valueByKey: ReadonlyMap<DocumentPropertyKey, DocumentPropertyValue>,
): DocumentPropertyValue | undefined => {
  const application = valueByKey.get("application");
  const version = valueByKey.get("applicationVersion");
  if (application?.type !== "text" || version?.type !== "text") {
    return application;
  }
  return { type: "text", value: `${application.value} ${version.value}` };
};

type EditablePropertyValueProps = {
  fileFieldId: string;
  label: string;
  propertyKey: AuthoredDocumentPropertyKey;
  value: string;
  workspaceId: string;
};

/**
 * One authored property, editable in place. Saves on blur or Enter, and only
 * when the value actually changed: every save writes a new document version, so
 * a stray focus must not add one.
 */
const EditablePropertyValue = ({
  fileFieldId,
  label,
  propertyKey,
  value,
  workspaceId,
}: EditablePropertyValueProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (draft === value) {
      return;
    }
    setSaving(true);
    const result = await Result.tryPromise(async () =>
      updateDocumentProperty({
        fieldId: fileFieldId,
        propertyKey,
        value: draft,
        workspaceId,
      }),
    );
    setSaving(false);

    if (Result.isError(result)) {
      setDraft(value);
      stellaToast.add({
        title: t("inspector.metadata.documentProperties.saveFailed"),
        type: "error",
      });
      return;
    }
    await queryClient.invalidateQueries({
      exact: true,
      queryKey: documentPropertiesQueryKey({
        workspaceId,
        fieldId: fileFieldId,
      }),
    });
  };

  return (
    <Input
      aria-label={label}
      className="h-7 text-sm"
      disabled={saving}
      onBlur={() => {
        detached(save(), "document-properties-section.save");
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(value);
        }
      }}
      value={draft}
    />
  );
};

const Message = ({ children }: { children: string }) => (
  <div className="px-4 py-4">
    <span className="text-muted-foreground text-sm">{children}</span>
  </div>
);
