/**
 * Shared inline-editable field component.
 *
 * Dispatches to a type-specific widget based on the property's
 * content.type discriminant. Each widget shows a display mode by
 * default and switches to edit mode on click. Changes are committed
 * on blur/Enter and cancelled on Escape.
 *
 * Used in: PDF right panel, table cells, inspector, kanban cards.
 */

import { useState, type ReactNode } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";
import { contentDir } from "@stll/ui/hooks/use-content-dir";

import { DatePickerPopover } from "@/components/date-picker-popover";
import Tooltip from "@/components/tooltip";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { isFileDisplayable } from "@/lib/types";
import type {
  EntityKind,
  WorkspaceFieldContent,
  WorkspaceProperty,
  WorkspacePropertyOption,
} from "@/lib/types";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import type { EditableFieldContent } from "@/routes/_protected.workspaces/$workspaceId/-components/edit-field-dialog";
import {
  FieldValue,
  type FieldValueVariant,
  IntFieldValue,
} from "@/routes/_protected.workspaces/$workspaceId/-components/field-value";
import { FieldValueSelect } from "@/routes/_protected.workspaces/$workspaceId/-components/field-value-select";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

type EditableFieldProps = {
  workspaceId: string;
  entityId: string;
  entityKind: EntityKind;
  fieldId?: string | undefined;
  propertyId: string;
  property: WorkspaceProperty;
  content: WorkspaceFieldContent | undefined;
  displayVariant?: FieldValueVariant | undefined;
  pendingPreview?: string | null | undefined;
  readonly?: boolean;
  showDateIcon?: boolean;
  /** Fires after a successful manual save — used to lock AI cells. */
  onManualSave?: () => void;
};

export const EditableField = ({
  workspaceId,
  entityId,
  entityKind,
  fieldId,
  propertyId,
  property,
  content,
  displayVariant,
  pendingPreview,
  readonly = false,
  showDateIcon = true,
  onManualSave,
}: EditableFieldProps) => {
  const type = property.content.type;
  const resolvedDisplayVariant = displayVariant ?? "default";

  // Non-editable types
  if (
    content?.type === "error" ||
    content?.type === "pending" ||
    content?.type === "unsupported" ||
    content?.type === "clip"
  ) {
    return (
      <FieldValue
        content={content}
        pendingPreview={pendingPreview}
        property={property}
        variant={resolvedDisplayVariant}
      />
    );
  }

  if (type === "file" || content?.type === "file") {
    return (
      <FileFieldDisplay
        content={content}
        displayVariant={resolvedDisplayVariant}
        entityId={entityId}
        fieldId={fieldId}
        property={property}
        propertyId={propertyId}
        workspaceId={workspaceId}
      />
    );
  }

  if (readonly) {
    return (
      <FieldValue
        content={content}
        property={property}
        variant={resolvedDisplayVariant}
      />
    );
  }

  return (
    <InlineEditor
      content={content}
      displayVariant={resolvedDisplayVariant}
      entityId={entityId}
      entityKind={entityKind}
      onManualSave={onManualSave}
      property={property}
      propertyId={propertyId}
      showDateIcon={showDateIcon}
      stopPropagation={resolvedDisplayVariant === "kanban"}
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
  displayVariant: FieldValueVariant;
  showDateIcon: boolean;
  stopPropagation: boolean;
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
  displayVariant,
  showDateIcon,
  stopPropagation,
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
        displayVariant={displayVariant}
        onSave={(value) => save({ type: "text", version: 1, value })}
        property={property}
        stopPropagation={stopPropagation}
        value={content?.type === "text" ? content.value : ""}
      />
    );
  }

  if (type === "date") {
    return (
      <InlineDateEditor
        displayVariant={displayVariant}
        onSave={(value) => save({ type: "date", version: 1, value })}
        property={property}
        showDateIcon={showDateIcon}
        stopPropagation={stopPropagation}
        value={content?.type === "date" ? content.value : null}
      />
    );
  }

  if (type === "int") {
    return (
      <InlineIntEditor
        currency={content?.type === "int" ? content.currency : null}
        displayVariant={displayVariant}
        onSave={(value, currency) =>
          save({ type: "int", version: 1, value, currency })
        }
        stopPropagation={stopPropagation}
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
      <InlineSelectEditor
        content={content}
        displayVariant={displayVariant}
        onChange={(value) => save({ type: "single-select", version: 1, value })}
        options={options}
        property={property}
        stopPropagation={stopPropagation}
        type="single-select"
        value={content?.type === "single-select" ? content.value : null}
      />
    );
  }

  return (
    <InlineSelectEditor
      content={content}
      displayVariant={displayVariant}
      onChange={(value) => save({ type: "multi-select", version: 1, value })}
      options={options}
      property={property}
      stopPropagation={stopPropagation}
      type="multi-select"
      value={content?.type === "multi-select" ? content.value : []}
    />
  );
};

// -- Select inline editor --
//
// Mirrors the text/int editors: a lightweight display by default, swapping to
// the live (heavy, Base UI) select only on click. Keeping every select cell as
// a display avoids mounting dozens of live dropdowns at once in the table.

type InlineSelectEditorProps = (
  | {
      type: "single-select";
      value: string | null | string[];
      onChange: (value: string | null) => void;
    }
  | {
      type: "multi-select";
      value: string | null | string[];
      onChange: (value: string[]) => void;
    }
) & {
  options: WorkspacePropertyOption[];
  property: WorkspaceProperty;
  content: WorkspaceFieldContent | undefined;
  displayVariant: FieldValueVariant;
  stopPropagation: boolean;
};

const InlineSelectEditor = (props: InlineSelectEditorProps) => {
  const { property, content, displayVariant, stopPropagation } = props;
  const [editing, setEditing] = useState(false);

  if (!editing) {
    const isEmpty =
      content?.type !== props.type ||
      (content.type === "single-select"
        ? content.value === null
        : content.value.length === 0);
    return (
      <button
        className="hover:bg-muted block w-full truncate rounded px-2 py-1 text-start text-sm transition-colors"
        onClick={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
          setEditing(true);
        }}
        onKeyDown={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
        }}
        type="button"
      >
        {isEmpty ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <FieldValue
            content={content}
            property={property}
            variant={displayVariant}
          />
        )}
      </button>
    );
  }

  const onOpenChange = (open: boolean) => {
    if (!open) {
      setEditing(false);
    }
  };

  if (props.type === "single-select") {
    const select = (
      <FieldValueSelect
        defaultOpen
        onChange={props.onChange}
        onOpenChange={onOpenChange}
        options={props.options}
        type="single-select"
        value={props.value}
      />
    );

    if (!stopPropagation) {
      return select;
    }

    return <ContainedFieldControl>{select}</ContainedFieldControl>;
  }

  const select = (
    <FieldValueSelect
      defaultOpen
      onChange={props.onChange}
      onOpenChange={onOpenChange}
      options={props.options}
      type="multi-select"
      value={props.value}
    />
  );

  if (!stopPropagation) {
    return select;
  }

  return <ContainedFieldControl>{select}</ContainedFieldControl>;
};

// -- Date inline editor --

const InlineDateEditor = ({
  value,
  displayVariant,
  onSave,
  property,
  showDateIcon,
  stopPropagation,
}: {
  value: string | null;
  displayVariant: FieldValueVariant;
  onSave: (value: string | null) => void;
  property: WorkspaceProperty;
  showDateIcon: boolean;
  stopPropagation: boolean;
}) => {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button
        className="hover:bg-muted block w-full truncate rounded px-2 py-1 text-start text-sm transition-colors"
        onClick={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
          setEditing(true);
        }}
        onKeyDown={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
        }}
        type="button"
      >
        <FieldValue
          content={{ type: "date", version: 1, value }}
          property={property}
          variant={displayVariant}
        />
      </button>
    );
  }

  const picker = (
    <DatePickerPopover
      defaultOpen
      onOpenChange={(open) => {
        if (!open) {
          setEditing(false);
        }
      }}
      onChange={(newValue) => {
        // Skip no-op saves to avoid unnecessary API calls and AI workflow re-runs
        if (newValue !== value) {
          onSave(newValue);
        }
        setEditing(false);
      }}
      showIcon={showDateIcon}
      value={value}
    />
  );

  if (!stopPropagation) {
    return picker;
  }

  return <ContainedFieldControl>{picker}</ContainedFieldControl>;
};

// -- Text inline editor --

const InlineTextEditor = ({
  value,
  displayVariant,
  onSave,
  property,
  stopPropagation,
}: {
  value: string;
  displayVariant: FieldValueVariant;
  onSave: (value: string) => void;
  property: WorkspaceProperty;
  stopPropagation: boolean;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <button
        className="hover:bg-muted block w-full truncate rounded px-2 py-1 text-start text-sm transition-colors"
        data-open-expanded-cell
        onClick={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
          // Drop straight into edit mode on first click. The
          // row-expansion side effect still fires via the
          // data-open-expanded-cell attribute the table grid reads,
          // so the cell gets the extra space at the same moment the
          // textarea mounts.
          setDraft(value);
          setEditing(true);
        }}
        onKeyDown={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
        }}
        type="button"
      >
        {value ? (
          <FieldValue
            content={{ type: "text", version: 1, value }}
            property={property}
            variant={displayVariant}
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
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
      onClick={(event) => {
        if (stopPropagation) {
          event.stopPropagation();
        }
      }}
      onKeyDown={(e) => {
        if (stopPropagation) {
          e.stopPropagation();
        }
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
  displayVariant,
  onSave,
  stopPropagation,
}: {
  value: number;
  currency: string | null;
  displayVariant: FieldValueVariant;
  onSave: (value: number, currency: string | null) => void;
  stopPropagation: boolean;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  if (!editing) {
    return (
      <button
        className="hover:bg-muted block w-full min-w-0 rounded px-2 py-1 text-start text-sm transition-colors"
        onClick={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
          setDraft(String(value));
          setEditing(true);
        }}
        onKeyDown={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
        }}
        type="button"
      >
        <IntFieldValue
          content={{ type: "int", version: 1, value, currency }}
          variant={displayVariant}
        />
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
      onClick={(event) => {
        if (stopPropagation) {
          event.stopPropagation();
        }
      }}
      onKeyDown={(e) => {
        if (stopPropagation) {
          e.stopPropagation();
        }
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

type ContainedFieldControlProps = {
  children: ReactNode;
};

const ContainedFieldControl = ({ children }: ContainedFieldControlProps) => (
  <span
    className="inline-flex min-w-0"
    onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
    role="presentation"
  >
    {children}
  </span>
);

type FileFieldDisplayProps = {
  content: WorkspaceFieldContent | undefined;
  displayVariant: FieldValueVariant;
  entityId: string;
  fieldId: string | undefined;
  property: WorkspaceProperty;
  propertyId: string;
  workspaceId: string;
};

const FileFieldDisplay = ({
  content,
  displayVariant,
  entityId,
  fieldId,
  property,
  propertyId,
  workspaceId,
}: FileFieldDisplayProps) => {
  if (content?.type !== "file" || fieldId === undefined) {
    return (
      <FieldValue
        content={content}
        property={property}
        variant={displayVariant}
      />
    );
  }

  if (displayVariant !== "table") {
    return (
      <FieldValue
        content={content}
        property={property}
        variant={displayVariant}
      />
    );
  }

  return (
    <TableFileField
      content={content}
      entityId={entityId}
      fieldId={fieldId}
      propertyId={propertyId}
      workspaceId={workspaceId}
    />
  );
};

type TableFileFieldProps = {
  content: Extract<WorkspaceFieldContent, { type: "file" }>;
  entityId: string;
  fieldId: string;
  propertyId: string;
  workspaceId: string;
};

const TableFileField = ({
  content,
  entityId,
  fieldId,
  workspaceId,
  propertyId,
}: TableFileFieldProps) => {
  const isDisplayable = isFileDisplayable({
    mimeType: content.mimeType,
    fileName: content.fileName,
    pdfFileId: content.pdfFileId ?? null,
    encrypted: content.encrypted,
  });
  const openFile = useInspectorStore((s) => s.openFile);

  if (isDisplayable) {
    return (
      <Tooltip
        content={content.fileName}
        render={
          <button
            className="bg-muted grid max-w-full min-w-0 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-center gap-1 rounded px-1 py-0.5 text-start"
            onClick={() =>
              openFile({
                id: fieldId,
                entityId,
                label: content.fileName,
                fileName: content.fileName,
                workspaceId,
                mimeType: content.mimeType,
                pdfFileId: content.pdfFileId,
                propertyId,
              })
            }
            type="button"
          />
        }
      >
        <DocumentIcon
          className="size-3.5 shrink-0"
          fileName={content.fileName}
          mimeType={content.mimeType}
        />
        <BidiText as="span" className="min-w-0 truncate text-start">
          {content.fileName}
        </BidiText>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      content={content.fileName}
      render={
        <span className="bg-muted grid max-w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-1 rounded px-1 py-0.5 text-start opacity-60" />
      }
    >
      <DocumentIcon
        className="size-3.5 shrink-0"
        fileName={content.fileName}
        mimeType={content.mimeType}
      />
      <BidiText as="span" className="min-w-0 truncate text-start">
        {content.fileName}
      </BidiText>
    </Tooltip>
  );
};
