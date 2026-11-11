import { useId, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Checkbox } from "@stll/ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import { DialogFormState } from "@stll/ui/dialog";
import { Label } from "@stll/ui/label";
import { ScrollArea } from "@stll/ui/scroll-area";
import { SearchField } from "@stll/ui/search-field";
import { TruncatedText } from "@stll/ui/truncated-text";

import { matchesComboboxItem } from "@/components/combobox-filter.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import {
  filterVisibleDocuments,
  pickableDocuments,
} from "@/components/workspaces/matter-document-picker.logic";
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

/**
 * The matter's stored DOCX/PDF documents to pick from: one document is a
 * searchable single choice, several a searchable checkbox list.
 */
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

  const formState = (
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
  );
  const heading = label ?? t("templates.prefillMatterDocuments");

  if (maxPicked === 1) {
    return (
      <>
        {formState}
        <SingleDocumentPicker
          disabled={disabled}
          documents={pickableDocuments(files ?? [])}
          label={heading}
          onChange={(entityId) => onChange(entityId === null ? [] : [entityId])}
          pickedEntityId={pickedEntityIds.at(0) ?? null}
        />
      </>
    );
  }

  const documents = filterVisibleDocuments(files ?? [], search);
  const toggle = (entityId: string) => {
    if (pickedEntityIds.includes(entityId)) {
      onChange(pickedEntityIds.filter((id) => id !== entityId));
      return;
    }
    if (pickedEntityIds.length >= maxPicked) {
      return;
    }
    onChange([...pickedEntityIds, entityId]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {formState}
      <QueryViewFeedback view={filesView} />
      <span className="text-muted-foreground text-xs font-medium">
        {heading}
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
                      (!checked && pickedEntityIds.length >= maxPicked)
                    }
                    onCheckedChange={() => toggle(doc.entityId)}
                  />
                  <TruncatedText render={<BidiText as="span" />}>
                    {doc.name ?? doc.fileName}
                  </TruncatedText>
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

type DocumentOption = { entityId: string; label: string };

type SingleDocumentPickerProps = {
  documents: readonly {
    entityId: string;
    fileName: string;
    name?: string | null;
  }[];
  pickedEntityId: string | null;
  label: string;
  disabled: boolean;
  onChange: (entityId: string | null) => void;
};

/** One document, chosen by typing its name or browsing the list. */
const SingleDocumentPicker = ({
  documents,
  pickedEntityId,
  label,
  disabled,
  onChange,
}: SingleDocumentPickerProps) => {
  const t = useTranslations();
  const id = useId();
  const options = documents.map((doc) => ({
    entityId: doc.entityId,
    label: doc.name ?? doc.fileName,
  }));
  const selected =
    options.find((option) => option.entityId === pickedEntityId) ?? null;
  return (
    <div className="flex w-full flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Combobox<DocumentOption>
        autoHighlight
        disabled={disabled}
        filter={matchesComboboxItem}
        isItemEqualToValue={(a, b) => a.entityId === b.entityId}
        items={options}
        itemToStringLabel={(item) => item.label}
        onValueChange={(option) => onChange(option?.entityId ?? null)}
        value={selected}
      >
        <ComboboxInput
          className="w-full"
          id={id}
          placeholder={t("common.search")}
          showClear={selected !== null}
        />
        <ComboboxPopup>
          <ComboboxList>
            {(item: DocumentOption) => (
              <ComboboxItem key={item.entityId} value={item}>
                <BidiText as="span" className="min-w-0 truncate">
                  {item.label}
                </BidiText>
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>{t("common.noResults")}</ComboboxEmpty>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
};
