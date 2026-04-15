import { useId, useState } from "react";

import { DEFAULT_ENTITY_LABELS } from "@stll/anonymize-wasm";
import { PlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@stella/ui/components/button";
import { Field, FieldError } from "@stella/ui/components/field";
import { Input } from "@stella/ui/components/input";
import { ScrollArea } from "@stella/ui/components/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { cn } from "@stella/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import { getEntityColor } from "@/lib/anonymize/ui-constants";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";

const LABEL_OPTIONS = [...DEFAULT_ENTITY_LABELS];

type AnonymizeSidebarAddEntityFormProps = {
  labelOptions: readonly string[];
  onAdd: (searchText: string, entityLabel: string) => number;
  onAdded: () => void;
  onCancel: () => void;
};

const AnonymizeSidebarAddEntityForm = ({
  labelOptions,
  onAdd,
  onAdded,
  onCancel,
}: AnonymizeSidebarAddEntityFormProps) => {
  const t = useTranslations();
  const searchInputId = useId();
  const [addText, setAddText] = useState("");
  const [addLabel, setAddLabel] = useState(labelOptions[0] ?? "person");
  const [noMatches, setNoMatches] = useState(false);

  const handleAdd = () => {
    const trimmed = addText.trim();
    if (!trimmed) {
      return;
    }
    const count = onAdd(trimmed, addLabel);
    if (count === 0) {
      setNoMatches(true);
      return;
    }
    setNoMatches(false);
    setAddText("");
    onAdded();
  };

  return (
    <form
      className="flex flex-col gap-3 border-b p-3"
      onSubmit={(event) => {
        event.preventDefault();
        handleAdd();
      }}
    >
      <Field invalid={noMatches}>
        <Input
          aria-invalid={noMatches}
          aria-label={t("anonymize.searchMatches")}
          autoFocus
          id={searchInputId}
          onChange={(e) => {
            setAddText(e.target.value);
            setNoMatches(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onCancel();
            }
          }}
          placeholder={t("anonymize.searchPlaceholder")}
          size="sm"
          value={addText}
        />
        {noMatches && (
          <FieldError match>{t("anonymize.noEntitiesFound")}</FieldError>
        )}
      </Field>

      <Select
        onValueChange={(v) => {
          if (v !== null) {
            setAddLabel(v);
          }
        }}
        value={addLabel}
      >
        <SelectTrigger
          aria-label={t("anonymize.entityType")}
          className="w-full"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {labelOptions.map((l) => (
            <SelectItem key={l} value={l}>
              {l}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          {t("common.cancel")}
        </Button>
        <Button
          disabled={!addText.trim()}
          size="sm"
          type="submit"
          variant="default"
        >
          {t("common.confirm")}
        </Button>
      </div>
    </form>
  );
};

type AnonymizeSidebarProps = {
  fieldId: string;
};

export const AnonymizeSidebar = ({ fieldId }: AnonymizeSidebarProps) => {
  const t = useTranslations();
  const storeFieldId = usePDFStore((s) => s.fieldId);
  const entities = usePDFStore(
    useShallow((s) => s.fileAnonymization?.entities ?? []),
  );
  const removeEntity = usePDFStore((s) => s.removeAnonymizationEntity);
  const relabelEntity = usePDFStore((s) => s.relabelAnonymizationEntity);
  const addEntityByText = usePDFStore((s) => s.addAnonymizationEntityByText);

  const [adding, setAdding] = useState(false);

  if (storeFieldId !== fieldId) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col border-s">
      <div
        className={cn(
          "flex items-center justify-between border-b px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <span className="text-base font-medium">
          {t("anonymize.entities")} ({entities.length})
        </span>
        <Tooltip
          content={
            adding ? t("anonymize.closeAddForm") : t("anonymize.addEntity")
          }
          render={
            <Button
              aria-label={
                adding ? t("anonymize.closeAddForm") : t("anonymize.addEntity")
              }
              onClick={() => setAdding(!adding)}
              size="icon-sm"
              variant="ghost"
            >
              {adding ? <XIcon /> : <PlusIcon />}
            </Button>
          }
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col text-sm sm:text-sm">
        {adding && (
          <AnonymizeSidebarAddEntityForm
            labelOptions={LABEL_OPTIONS}
            onAdd={(searchText, entityLabel) =>
              addEntityByText(searchText, entityLabel)
            }
            onAdded={() => setAdding(false)}
            onCancel={() => setAdding(false)}
          />
        )}

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-2 p-3">
            {entities.length === 0 && (
              <div className="text-muted-foreground p-2 text-center">
                {t("anonymize.noEntitiesFound")}
              </div>
            )}
            {entities.map((e) => (
              <div key={e.id} className="rounded border p-2">
                <div className="flex items-center justify-between gap-1">
                  <span
                    className="truncate rounded px-1 font-mono"
                    style={{ backgroundColor: getEntityColor(e.label) }}
                    title={e.text}
                  >
                    {e.text}
                  </span>
                  <Tooltip
                    content={t("anonymize.removeEntity")}
                    render={
                      <Button
                        aria-label={t("anonymize.removeEntity")}
                        className="text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => removeEntity(e.id)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <XIcon />
                      </Button>
                    }
                  />
                </div>
                <div className="mt-1">
                  <Select
                    onValueChange={(v) => {
                      if (v !== null) {
                        relabelEntity(e.id, v);
                      }
                    }}
                    value={e.label}
                  >
                    <SelectTrigger
                      aria-label={t("anonymize.entityType")}
                      className="w-full"
                      size="sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {LABEL_OPTIONS.map((l) => (
                        <SelectItem key={l} value={l}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
};
