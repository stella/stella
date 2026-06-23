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

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";
import { contentDir } from "@stll/ui/hooks/use-content-dir";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type {
  EntityKind,
  WorkspaceFieldContent,
  WorkspaceProperty,
} from "@/lib/types";
import type { EditableFieldContent } from "@/routes/_protected.workspaces/$workspaceId/-components/edit-field-dialog";
import {
  FieldValue,
  IntFieldValue,
} from "@/routes/_protected.workspaces/$workspaceId/-components/field-value";
import { FieldValueSelect } from "@/routes/_protected.workspaces/$workspaceId/-components/field-value-select";
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
  showDateIcon?: boolean;
  /** Fires after a successful manual save — used to lock AI cells. */
  onManualSave?: () => void;
};

export const EditableField = ({
  workspaceId,
  entityId,
  entityKind,
  propertyId,
  property,
  content,
  readonly = false,
  showDateIcon = true,
  onManualSave,
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
    return <FieldValue content={content} property={property} />;
  }

  if (readonly) {
    return <FieldValue content={content} property={property} />;
  }

  return (
    <InlineEditor
      content={content}
      entityId={entityId}
      entityKind={entityKind}
      onManualSave={onManualSave}
      property={property}
      propertyId={propertyId}
      showDateIcon={showDateIcon}
      type={type}
      workspaceId={workspaceId}
    />
  );
};

// -- Inline editor --

type InlineEditorOnManualSave = (() => void) | undefined;

type InlineEditorProps = {
  workspaceId: string;
  entityId: string;
  entityKind: EntityKind;
  propertyId: string;
  property: WorkspaceProperty;
  content: WorkspaceFieldContent | undefined;
  type: "text" | "date" | "single-select" | "multi-select" | "int";
  showDateIcon: boolean;
  onManualSave: InlineEditorOnManualSave;
};

const InlineEditor = ({
  workspaceId,
  entityId,
  entityKind,
  propertyId,
  property,
  content,
  type,
  showDateIcon,
  onManualSave,
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
      // Manual edit on an AI-extraction cell should latch the
      // cell so the next workflow sweep doesn't overwrite what
      // the user just wrote. Manual-input cells pass no callback
      // and never re-run AI on themselves, so the call is a no-op
      // there.
      onManualSave?.();
      // Folders can't have AI-derived metadata
      if (entityKind === "folder") {
        return;
      }
      // Trigger dependent AI columns after manual edit
      void startWorkflow({ entityIds: [entityId] });
    },
    onError: () => {
      stellaToast.add({
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
        showIcon={showDateIcon}
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

  const options =
    property.content.type === "single-select" ||
    property.content.type === "multi-select"
      ? property.content.options
      : [];
  if (type === "single-select") {
    return (
      <FieldValueSelect
        onChange={(value) => save({ type: "single-select", version: 1, value })}
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
        data-open-expanded-cell
        onClick={() => {
          // Drop straight into edit mode on first click. The
          // row-expansion side effect still fires via the
          // data-open-expanded-cell attribute the table grid reads,
          // so the cell gets the extra space at the same moment the
          // textarea mounts.
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
      className="border-input bg-background focus:ring-ring min-h-20 w-full min-w-0 resize-none rounded-md border px-2 py-1 text-sm outline-none focus:ring-1"
      dir={contentDir(draft)}
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
        className="hover:bg-muted block w-full min-w-0 rounded px-2 py-1 text-start text-sm transition-colors"
        onClick={() => {
          setDraft(String(value));
          setEditing(true);
        }}
        type="button"
      >
        <IntFieldValue content={{ type: "int", version: 1, value, currency }} />
      </button>
    );
  }

  return (
    <Input
      autoFocus
      className="h-8 text-sm"
      dir="ltr"
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
