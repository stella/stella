import { Result } from "better-result";
import { Loader2Icon, SquareMinusIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Skeleton } from "@stll/ui/components/skeleton";

import type { WorkspaceFieldContent, WorkspaceProperty } from "@/lib/types";
import {
  emptyColor,
  resolveOptionColor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/utils";

type FieldValueVariant = "default" | "table" | "kanban";

type FieldValueProps = {
  content: WorkspaceFieldContent | undefined;
  property: WorkspaceProperty;
  pendingPreview?: string | null | undefined;
  variant?: FieldValueVariant;
};

export const FieldValue = ({
  content,
  property,
  pendingPreview,
  variant,
}: FieldValueProps) => {
  const resolvedVariant = variant ?? "default";

  if (!content) {
    return resolvedVariant === "table" ? null : (
      <EmptyFieldValue variant={resolvedVariant} />
    );
  }

  if (content.type === "pending") {
    return (
      <PendingFieldValue
        contentType={property.content.type}
        preview={pendingPreview}
        variant={resolvedVariant}
      />
    );
  }

  if (content.type === "error") {
    return <ErrorFieldValue variant={resolvedVariant} />;
  }

  if (content.type === "unsupported") {
    return <UnsupportedFieldValue variant={resolvedVariant} />;
  }

  if (content.type === "file") {
    return <FileFieldValue content={content} variant={resolvedVariant} />;
  }

  if (content.type === "text") {
    return <TextFieldValue content={content} variant={resolvedVariant} />;
  }

  if (content.type === "date") {
    return (
      <DateFieldValue
        content={content}
        property={property}
        variant={resolvedVariant}
      />
    );
  }

  if (content.type === "int") {
    return <IntFieldValue content={content} variant={resolvedVariant} />;
  }

  if (content.type === "single-select") {
    return (
      <SelectFieldValue
        property={property}
        value={content.value}
        variant={resolvedVariant}
      />
    );
  }

  if (content.type === "multi-select") {
    return (
      <MultiSelectFieldValue
        property={property}
        value={content.value}
        variant={resolvedVariant}
      />
    );
  }

  return <ClipFieldValue content={content} variant={resolvedVariant} />;
};

export const IntFieldValue = ({
  content,
  variant,
}: {
  content: Extract<WorkspaceFieldContent, { type: "int" }>;
  variant?: FieldValueVariant;
}) => {
  const format = useFormatter();
  const resolvedVariant = variant ?? "default";
  const className = getIntClassName(resolvedVariant);
  const fallback = `${format.number(content.value)} ${content.currency}`;

  if (!content.currency) {
    return <span className={className}>{format.number(content.value)}</span>;
  }

  const formattedResult = Result.try(() =>
    format.number(content.value, {
      style: "currency",
      currency: content.currency ?? undefined,
      minimumFractionDigits: 0,
    }),
  );

  if (formattedResult.isErr()) {
    return <span className={className}>{fallback}</span>;
  }

  return <span className={className}>{formattedResult.value}</span>;
};

const EmptyFieldValue = ({ variant }: { variant: FieldValueVariant }) => {
  if (variant === "kanban") {
    return null;
  }

  return <span className="text-muted-foreground text-sm">—</span>;
};

const PendingFieldValue = ({
  contentType,
  preview,
  variant,
}: {
  contentType: WorkspaceProperty["content"]["type"];
  preview: string | null | undefined;
  variant: FieldValueVariant;
}) => {
  const t = useTranslations();
  const trimmedPreview = preview?.trim();
  const hasPreview = trimmedPreview !== undefined && trimmedPreview.length > 0;

  if (variant === "kanban") {
    return null;
  }

  if (variant === "table") {
    return (
      <>
        <Loader2Icon
          aria-hidden="true"
          className="text-muted-foreground absolute end-1 top-1 z-20 size-3 shrink-0 animate-spin"
          strokeWidth={2.25}
        />
        {hasPreview ? (
          <div className="line-clamp-2 min-w-0" dir="auto">
            {trimmedPreview}
          </div>
        ) : (
          <PendingSkeleton contentType={contentType} />
        )}
      </>
    );
  }

  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
      {t("workspaces.fields.calculating")}
      <span className="bg-muted-foreground size-2 animate-pulse rounded-full" />
    </span>
  );
};

const ErrorFieldValue = ({ variant }: { variant: FieldValueVariant }) => {
  const t = useTranslations();

  if (variant === "kanban") {
    return null;
  }

  return (
    <span className="text-destructive line-clamp-2 text-sm italic">
      {t("workspaces.fields.errored")}
    </span>
  );
};

const UnsupportedFieldValue = ({ variant }: { variant: FieldValueVariant }) => {
  const t = useTranslations();

  if (variant === "kanban") {
    return null;
  }

  return (
    <span className="text-muted-foreground line-clamp-2 text-sm italic">
      {t("workspaces.fields.formatNotSupported")}
    </span>
  );
};

const FileFieldValue = ({
  content,
  variant,
}: {
  content: Extract<WorkspaceFieldContent, { type: "file" }>;
  variant: FieldValueVariant;
}) => {
  if (variant === "kanban") {
    return null;
  }

  return (
    <BidiText
      as="span"
      className={variant === "table" ? "truncate" : "text-sm"}
    >
      {content.fileName}
    </BidiText>
  );
};

const TextFieldValue = ({
  content,
  variant,
}: {
  content: Extract<WorkspaceFieldContent, { type: "text" }>;
  variant: FieldValueVariant;
}) => {
  if (variant === "kanban") {
    if (!content.value.trim()) {
      return null;
    }

    return (
      <span className="text-muted-foreground line-clamp-2 min-w-0 basis-full text-xs leading-4">
        {content.value}
      </span>
    );
  }

  const className =
    variant === "table" ? "line-clamp-2" : "line-clamp-2 text-sm";

  return (
    <span className={className} dir="auto">
      {content.value}
    </span>
  );
};

const DateFieldValue = ({
  content,
  property,
  variant,
}: {
  content: Extract<WorkspaceFieldContent, { type: "date" }>;
  property: WorkspaceProperty;
  variant: FieldValueVariant;
}) => {
  const format = useFormatter();

  const date = content.value ? new Date(content.value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    if (variant === "table") {
      return (
        <SelectFieldValue property={property} value={null} variant={variant} />
      );
    }
    return <EmptyFieldValue variant={variant} />;
  }

  const formatted = format.dateTime(date, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  if (variant === "kanban") {
    return (
      <span className="text-muted-foreground bg-muted/60 rounded px-1.5 py-0.5 text-xs leading-none">
        {formatted}
      </span>
    );
  }

  return (
    <span className={variant === "default" ? "text-sm" : undefined}>
      {formatted}
    </span>
  );
};

const SelectFieldValue = ({
  property,
  value,
  variant,
}: {
  property: WorkspaceProperty;
  value: string | null;
  variant: FieldValueVariant;
}) => {
  const t = useTranslations();
  const color = getSelectPropertyColor(property, value);

  if (variant === "kanban") {
    return (
      <span
        className="max-w-full truncate rounded px-1.5 py-0.5 text-xs leading-none font-medium"
        style={{
          backgroundColor: color?.background,
          color: color?.foreground,
        }}
      >
        {value ?? t("common.empty")}
      </span>
    );
  }

  return (
    <span
      className={
        variant === "table"
          ? "flex max-w-full items-center gap-x-1 rounded px-1 py-0.25 font-medium"
          : "flex w-max max-w-full items-center gap-x-1 rounded px-1 py-0.25 text-sm font-medium"
      }
      style={{
        backgroundColor: color?.background,
        color: color?.foreground,
      }}
    >
      {variant === "table" && !value && <SquareMinusIcon className="size-4" />}
      <span className="truncate" dir="auto">
        {value ?? t("common.empty")}
      </span>
    </span>
  );
};

const MultiSelectFieldValue = ({
  property,
  value,
  variant,
}: {
  property: WorkspaceProperty;
  value: string[];
  variant: FieldValueVariant;
}) => {
  if (value.length === 0) {
    if (variant === "table") {
      return (
        <SelectFieldValue property={property} value={null} variant={variant} />
      );
    }
    return <EmptyFieldValue variant={variant} />;
  }

  return (
    <span
      className={
        variant === "table"
          ? "flex min-w-0 flex-wrap gap-1.5"
          : "flex flex-wrap gap-1"
      }
    >
      {value.map((option) => (
        <SelectFieldValue
          key={option}
          property={property}
          value={option}
          variant={variant}
        />
      ))}
    </span>
  );
};

const ClipFieldValue = ({
  content,
  variant,
}: {
  content: Extract<WorkspaceFieldContent, { type: "clip" }>;
  variant: FieldValueVariant;
}) => {
  const value = content.citation ?? content.url;

  if (variant === "kanban") {
    return (
      <span className="text-muted-foreground bg-muted/60 truncate rounded px-1.5 py-0.5 text-xs leading-none">
        {value}
      </span>
    );
  }

  return (
    <span className="text-muted-foreground block truncate text-sm" dir="auto">
      {value}
    </span>
  );
};

type PendingSkeletonProps = {
  contentType: WorkspaceProperty["content"]["type"];
};

const PendingSkeleton = ({ contentType }: PendingSkeletonProps) => {
  if (contentType === "single-select") {
    return <Skeleton className="h-4 w-16 rounded-full" />;
  }

  if (contentType === "multi-select") {
    return (
      <div className="flex flex-wrap gap-1">
        <Skeleton className="h-4 w-12 rounded-full" />
        <Skeleton className="h-4 w-16 rounded-full" />
      </div>
    );
  }

  if (contentType === "date") {
    return <Skeleton className="h-3.5 w-20" />;
  }

  if (contentType === "int") {
    return <Skeleton className="h-3.5 w-10" />;
  }

  if (contentType === "file") {
    return <Skeleton className="h-4 w-24" />;
  }

  return (
    <div className="flex w-full max-w-[12rem] flex-col gap-1">
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-3/4" />
    </div>
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
    property.content.type !== "single-select" &&
    property.content.type !== "multi-select"
  ) {
    return undefined;
  }

  const color = property.content.options.find((o) => o.value === option)?.color;

  if (!color) {
    return undefined;
  }

  return resolveOptionColor(color);
};

const getIntClassName = (variant: FieldValueVariant) => {
  if (variant === "kanban") {
    return "text-muted-foreground bg-muted/60 rounded px-1.5 py-0.5 text-xs leading-none tabular-nums";
  }

  if (variant === "table") {
    return "block max-w-full min-w-0 truncate text-start tabular-nums";
  }

  return "block min-w-0 max-w-full truncate text-start text-sm tabular-nums";
};
