import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Checkbox } from "@stll/ui/checkbox";
import { DialogFormState } from "@stll/ui/dialog";
import { Label } from "@stll/ui/label";
import { ScrollArea } from "@stll/ui/scroll-area";
import { SearchField } from "@stll/ui/search-field";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { filterVisibleDocuments } from "@/components/workspaces/matter-document-picker.logic";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { workspaceFilesOptions } from "@/lib/workspaces/queries/entities";

type MatterDocumentPickerProps = {
  workspaceId: string;
  pickedEntityIds: string[];
  maxPicked?: number;
  disabled?: boolean;
  label?: string;
  onChange: (entityIds: string[]) => void;
};

/** Searchable checkbox list over the matter's stored DOCX/PDF documents. */
export const MatterDocumentPicker = ({
  workspaceId,
  pickedEntityIds,
  onChange,
  maxPicked = 5,
  disabled = false,
  label,
}: MatterDocumentPickerProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const [initialPickedEntityIds] = useState(() => [...pickedEntityIds]);
  const filesQuery = useQuery(workspaceFilesOptions(workspaceId));
  const filesView = queryView(filesQuery);
  useQueryViewError(filesView, "MatterDocumentPicker:query");
  const files = filesView.type === "items" ? filesView.items : undefined;

  const documents = filterVisibleDocuments(files ?? [], search);

  switch (filesView.type) {
    case "pending":
    case "error":
      return <QueryViewFeedback view={filesView} />;
    case "empty":
    case "items":
      break;
    default:
      filesView satisfies never;
      return panic("Unhandled matter document query state");
  }

  const toggle = (entityId: string) => {
    if (pickedEntityIds.includes(entityId)) {
      onChange(pickedEntityIds.filter((id) => id !== entityId));
      return;
    }
    if (maxPicked === 1) {
      onChange([entityId]);
      return;
    }
    if (pickedEntityIds.length >= maxPicked) {
      return;
    }
    onChange([...pickedEntityIds, entityId]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <DialogFormState
        dirty={
          pickedEntityIds.length !== initialPickedEntityIds.length ||
          pickedEntityIds.some((id) => !initialPickedEntityIds.includes(id))
        }
        onDiscard={() => {
          onChange(initialPickedEntityIds);
          setSearch("");
        }}
      />
      <QueryViewFeedback view={filesView} />
      <span className="text-muted-foreground text-xs font-medium">
        {label ?? t("templates.prefillMatterDocuments")}
      </span>
      <SearchField
        aria-label={t("common.search")}
        placeholder={t("common.search")}
        clearLabel={t("common.cancel")}
        disabled={disabled}
        value={search}
        onValueChange={setSearch}
      />
      <div className="rounded-lg border">
        <ScrollArea className="h-36">
          <div className="flex flex-col gap-1 p-2">
            {documents.map((doc) => {
              const checked = pickedEntityIds.includes(doc.entityId);
              return (
                <Label key={doc.entityId} variant="choice">
                  <Checkbox
                    aria-label={doc.name ?? doc.fileName}
                    checked={checked}
                    disabled={
                      disabled ||
                      (!checked &&
                        maxPicked !== 1 &&
                        pickedEntityIds.length >= maxPicked)
                    }
                    onCheckedChange={() => toggle(doc.entityId)}
                  />
                  <BidiText as="span" className="min-w-0 truncate">
                    {doc.name ?? doc.fileName}
                  </BidiText>
                </Label>
              );
            })}
            {documents.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {t("common.noResults")}
              </p>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
};
