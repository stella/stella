import { Result } from "better-result";
import { SquareMinusIcon } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import Tooltip from "@/components/tooltip";
import { isFileDisplayable } from "@/lib/types";
import type { WorkspaceField, WorkspaceProperty } from "@/lib/types";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  emptyColor,
  resolveOptionColor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/utils";

type CellResultProps = {
  field: WorkspaceField | undefined;
  property: WorkspaceProperty;
};

export const CellResult = ({ field, property }: CellResultProps) => {
  const t = useTranslations();
  const locale = useLocale();

  if (!field) {
    return null;
  }

  const type = field.content.type;

  if (type === "pending") {
    return (
      <div className="grid grid-cols-[1fr_auto] items-center justify-between gap-1.5">
        <span>{t("workspaces.fields.calculating")}</span>
        <span className="bg-muted-foreground size-2 shrink-0 animate-pulse rounded-full" />
      </div>
    );
  }

  if (type === "error") {
    return (
      <span className="text-destructive italic">
        {t("workspaces.fields.errored")}
      </span>
    );
  }

  if (type === "unsupported") {
    return (
      <span className="text-muted-foreground italic">
        {t("workspaces.fields.formatNotSupported")}
      </span>
    );
  }

  if (type === "file") {
    return (
      <FileCell
        encrypted={field.content.encrypted ?? false}
        entityId={field.entityId}
        fieldId={field.id}
        fileName={field.content.fileName}
        mimeType={field.content.mimeType}
        pdfFileId={field.content.pdfFileId ?? null}
        propertyId={property.id}
        workspaceId={property.workspaceId}
      />
    );
  }

  if (type === "single-select") {
    return <SelectResult property={property} value={field.content.value} />;
  }

  if (type === "multi-select") {
    return field.content.value.length > 0 ? (
      <div className="flex flex-wrap gap-1.5">
        {field.content.value.map((value) => (
          <SelectResult key={value} property={property} value={value} />
        ))}
      </div>
    ) : (
      <SelectResult property={property} value={null} />
    );
  }

  if (type === "date") {
    if (!field.content.value) {
      return <SelectResult property={property} value={null} />;
    }

    const formatted = new Date(field.content.value).toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });

    return <div>{formatted}</div>;
  }

  if (type === "int") {
    return (
      <IntCell currency={field.content.currency} value={field.content.value} />
    );
  }

  if (type === "clip") {
    return (
      <div className="text-muted-foreground truncate">{field.content.url}</div>
    );
  }

  return <div className="whitespace-break-spaces">{field.content.value}</div>;
};

type FileCellProps = {
  fileName: string;
  mimeType: string;
  fieldId: string;
  entityId: string;
  encrypted: boolean;
  pdfFileId: string | null;
  propertyId: string;
  workspaceId: string;
};

const FileCell = ({
  fileName,
  mimeType,
  fieldId,
  entityId,
  encrypted,
  pdfFileId,
  workspaceId,
  propertyId,
}: FileCellProps) => {
  const isDisplayable = isFileDisplayable({ mimeType, pdfFileId, encrypted });
  const openPdf = useInspectorStore((s) => s.openPdf);

  if (isDisplayable) {
    return (
      <Tooltip
        content={fileName}
        render={
          <button
            className="bg-muted grid max-w-max cursor-pointer grid-cols-[1rem_auto] items-center gap-1 rounded px-1 py-0.5"
            onClick={() =>
              openPdf({
                id: fieldId,
                entityId,
                label: fileName,
                workspaceId,
                mimeType,
                propertyId,
              })
            }
            type="button"
          />
        }
      >
        <DocumentIcon className="size-3.5 shrink-0" mimeType={mimeType} />
        <span className="truncate">{fileName}</span>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      content={fileName}
      render={
        <span className="bg-muted grid max-w-max grid-cols-[1rem_auto] items-center gap-1 rounded px-1 py-0.5 opacity-60" />
      }
    >
      <DocumentIcon className="size-3.5 shrink-0" mimeType={mimeType} />
      <span className="truncate">{fileName}</span>
    </Tooltip>
  );
};

const getSelectPropertyColor = (
  property: WorkspaceProperty,
  option: string | null,
) => {
  if (!option) {
    return emptyColor;
  }

  if (
    property.content.type === "file" ||
    property.content.type === "text" ||
    property.content.type === "date" ||
    property.content.type === "int"
  ) {
    return undefined;
  }

  const color = property.content.options.find((o) => o.value === option)?.color;

  if (!color) {
    return undefined;
  }

  return resolveOptionColor(color);
};

type SelectResultProps = {
  value: string | null;
  property: WorkspaceProperty;
};

const SelectResult = ({ value, property }: SelectResultProps) => {
  const t = useTranslations();
  const color = getSelectPropertyColor(property, value);

  return (
    <span
      className="flex w-max items-center gap-x-1 rounded px-1 py-0.25 font-medium"
      style={{
        backgroundColor: color?.background,
        color: color?.foreground,
      }}
    >
      {!value && <SquareMinusIcon className="size-4" />}
      {value ?? t("common.empty")}
    </span>
  );
};

type IntCellProps = {
  value: number;
  currency: string | null;
};

const IntCell = ({ value, currency }: IntCellProps) => {
  if (!currency) {
    return <div>{new Intl.NumberFormat().format(value)}</div>;
  }

  const formattedResult = Result.try(() =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
    }).format(value),
  );

  if (formattedResult.isErr()) {
    return (
      <div>
        {new Intl.NumberFormat().format(value)} {currency}
      </div>
    );
  }

  return <div>{formattedResult.value}</div>;
};
