/**
 * Shared inline-editable field component.
 *
 * Dispatches to a type-specific widget based on the property's
 * content.type discriminant. Each widget shows a display mode by
 * default and switches to edit mode on click. Changes are committed
 * on blur/Enter and cancelled on Escape.
 *
 * Used in: PDF right panel, table cells (follow-up), inspector,
 * kanban cards.
 */

import { useState } from "react";

import { DatePickerPopover } from "@stll/ui/components/date-picker-popover";
import { Input } from "@stll/ui/components/input";
import { toastManager } from "@stll/ui/components/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type {
  EntityKind,
  WorkspaceFieldContent,
  WorkspaceProperty,
} from "@/lib/types";
import type { EditableFieldContent } from "@/routes/_protected.workspaces/$workspaceId/-components/edit-field-dialog";
import { FieldValueSelect } from "@/routes/_protected.workspaces/$workspaceId/-components/field-value-select";
import {
  emptyColor,
  resolveOptionColor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

type EditableFieldProps = {
  workspaceId: string;
  entityId: string;
  entityKind: EntityKind;
  propertyId: string;
  property: WorkspaceProperty;
  content: WorkspaceFieldContent | undefined;
  readonly?: boolean;
};

export const EditableField = ({
  workspaceId,
  entityId,
  entityKind,
  propertyId,
  property,
  content,
  readonly = false,
}: EditableFieldProps) => {
  const type = property.content.type;

  // Non-editable types
  if (
    type === "file" ||
    content?.type === "error" ||
    content?.type === "pending" ||
    content?.type === "unsupported" ||
    content?.type === "clip"
  ) {
    return <ReadOnlyDisplay content={content} />;
  }

  if (readonly) {
    return <ReadOnlyValue content={content} property={property} />;
  }

  return (
    <InlineEditor
      content={content}
      entityId={entityId}
      entityKind={entityKind}
      property={property}
      propertyId={propertyId}
      type={type}
      workspaceId={workspaceId}
    />
  );
};

// -- Read-only fallbacks --

const ReadOnlyDisplay = ({
  content,
}: {
  content: WorkspaceFieldContent | undefined;
}) => {
  const t = useTranslations();

  if (!content) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }

  if (content.type === "pending") {
    return (
      <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
        {t("workspaces.fields.calculating")}
        <span className="bg-muted-foreground size-2 animate-pulse rounded-full" />
      </span>
    );
  }

  if (content.type === "error") {
    return (
      <span className="text-destructive text-sm italic">
        {t("workspaces.fields.errored")}
      </span>
    );
  }

  return <span className="text-muted-foreground text-sm">—</span>;
};

const ReadOnlyValue = ({
  content,
  property,
}: {
  content: WorkspaceFieldContent | undefined;
  property: WorkspaceProperty;
}) => {
  if (!content || content.type === "error" || content.type === "pending") {
    return <span className="text-muted-foreground text-sm">—</span>;
  }

  if (content.type === "text") {
    return <span className="line-clamp-2 text-sm">{content.value}</span>;
  }

  if (content.type === "date") {
    if (!content.value) {
      return <span className="text-muted-foreground text-sm">—</span>;
    }
    return (
      <span className="text-sm">
        {new Date(content.value).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        })}
      </span>
    );
  }

  if (content.type === "int") {
    return <IntDisplay currency={content.currency} value={content.value} />;
  }

  if (content.type === "single-select") {
    return <SelectChip property={property} value={content.value} />;
  }

  if (content.type === "multi-select") {
    if (content.value.length === 0) {
      return <span className="text-muted-foreground text-sm">—</span>;
    }
    return (
      <div className="flex flex-wrap gap-1">
        {content.value.map((v) => (
          <SelectChip key={v} property={property} value={v} />
        ))}
      </div>
    );
  }

  return <span className="text-muted-foreground text-sm">—</span>;
};

// -- Inline editor --

type InlineEditorProps = {
  workspaceId: string;
  entityId: string;
  entityKind: EntityKind;
  propertyId: string;
  property: WorkspaceProperty;
  content: WorkspaceFieldContent | undefined;
  type: "text" | "date" | "single-select" | "multi-select" | "int";
};

const InlineEditor = ({
  workspaceId,
  entityId,
  entityKind,
  propertyId,
  property,
  content,
  type,
}: InlineEditorProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const startWorkflow = useStartWorkflow(workspaceId);

  const upsertField = useMutation({
    mutationFn: async (newContent: EditableFieldContent) => {
      const response = await api
        .fields({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .post({
          queryKey: entitiesKeys.all(workspaceId),
          propertyId: toSafeId<"property">(propertyId),
          entityId: toSafeId<"entity">(entityId),
          content: newContent,
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
      // Folders can't have AI-derived metadata
      if (entityKind === "folder") {
        return;
      }
      // Trigger dependent AI columns after manual edit
      void startWorkflow({ entityIds: [entityId] });
    },
    onError: () => {
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });

  const save = (newContent: EditableFieldContent) => {
    upsertField.mutate(newContent);
  };

  if (type === "text") {
    return (
      <InlineTextEditor
        onSave={(value) => save({ type: "text", version: 1, value })}
        value={content?.type === "text" ? content.value : ""}
      />
    );
  }

  if (type === "date") {
    const currentDate = content?.type === "date" ? content.value : null;
    return (
      <DatePickerPopover
        onChange={(value) => {
          // Skip no-op saves to avoid unnecessary API calls and AI workflow re-runs
          if (value !== currentDate) {
            save({ type: "date", version: 1, value });
          }
        }}
        value={currentDate}
      />
    );
  }

  if (type === "int") {
    return (
      <InlineIntEditor
        currency={content?.type === "int" ? content.currency : null}
        onSave={(value, currency) =>
          save({ type: "int", version: 1, value, currency })
        }
        value={content?.type === "int" ? content.value : 0}
      />
    );
  }

  if (type === "single-select" || type === "multi-select") {
    const options =
      property.content.type === "single-select" ||
      property.content.type === "multi-select"
        ? property.content.options
        : [];

    if (type === "single-select") {
      return (
        <FieldValueSelect
          onChange={(value) =>
            save({ type: "single-select", version: 1, value })
          }
          options={options}
          type="single-select"
          value={content?.type === "single-select" ? content.value : null}
        />
      );
    }

    return (
      <FieldValueSelect
        onChange={(value) => save({ type: "multi-select", version: 1, value })}
        options={options}
        type="multi-select"
        value={content?.type === "multi-select" ? content.value : []}
      />
    );
  }

  return <span className="text-muted-foreground text-sm">—</span>;
};

// -- Text inline editor --

const InlineTextEditor = ({
  value,
  onSave,
}: {
  value: string;
  onSave: (value: string) => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <button
        className="hover:bg-muted block w-full truncate rounded px-2 py-1 text-start text-sm transition-colors"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        type="button"
      >
        {value || <span className="text-muted-foreground">—</span>}
      </button>
    );
  }

  return (
    <textarea
      autoFocus
      className="border-input bg-background focus:ring-ring w-full min-w-0 resize-none rounded-md border px-2 py-1 text-sm outline-none focus:ring-1"
      onBlur={() => {
        const trimmed = draft.trim();
        if (trimmed !== value) {
          onSave(trimmed);
        }
        setEditing(false);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setEditing(false);
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      rows={2}
      value={draft}
    />
  );
};

// -- Int inline editor --

const InlineIntEditor = ({
  value,
  currency,
  onSave,
}: {
  value: number;
  currency: string | null;
  onSave: (value: number, currency: string | null) => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  if (!editing) {
    return (
      <button
        className="hover:bg-muted w-full rounded px-2 py-1 text-start text-sm transition-colors"
        onClick={() => {
          setDraft(String(value));
          setEditing(true);
        }}
        type="button"
      >
        <IntDisplay currency={currency} value={value} />
      </button>
    );
  }

  return (
    <Input
      autoFocus
      className="h-8 text-sm"
      inputMode="numeric"
      onBlur={() => {
        const num = Math.round(Number(draft));
        if (!Number.isNaN(num) && Number.isFinite(num) && num !== value) {
          onSave(num, currency);
        }
        setEditing(false);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setEditing(false);
        }
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
      value={draft}
    />
  );
};

// -- Shared display helpers --

const IntDisplay = ({
  value,
  currency,
}: {
  value: number;
  currency: string | null;
}) => {
  if (!currency) {
    return (
      <span className="text-sm">{new Intl.NumberFormat().format(value)}</span>
    );
  }

  try {
    const formatted = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
    }).format(value);
    return <span className="text-sm">{formatted}</span>;
  } catch {
    return (
      <span className="text-sm">
        {new Intl.NumberFormat().format(value)} {currency}
      </span>
    );
  }
};

const SelectChip = ({
  property,
  value,
}: {
  property: WorkspaceProperty;
  value: string | null;
}) => {
  const t = useTranslations();

  const color = (() => {
    if (!value) {
      return emptyColor;
    }
    if (
      property.content.type !== "single-select" &&
      property.content.type !== "multi-select"
    ) {
      return undefined;
    }
    const opt = property.content.options.find((o) => o.value === value)?.color;
    return opt ? resolveOptionColor(opt) : undefined;
  })();

  return (
    <span
      className="flex w-max items-center gap-x-1 rounded px-1 py-0.25 text-sm font-medium"
      style={{
        backgroundColor: color?.background,
        color: color?.foreground,
      }}
    >
      {value ?? t("common.empty")}
    </span>
  );
};
