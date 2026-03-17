import { useState } from "react";

import { PanelRightCloseIcon, PlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { DEFAULT_ENTITY_LABELS } from "@stella/anonymize";
import { Button } from "@stella/ui/components/button";
import { ScrollArea } from "@stella/ui/components/scroll-area";
import { cn } from "@stella/ui/lib/utils";

import { ENTITY_COLORS } from "@/lib/anonymize/ui-constants";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { useAnonymiseOverlayStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymise-pdf";

const LABEL_OPTIONS = [...DEFAULT_ENTITY_LABELS];

const colorFor = (label: string): string =>
  ENTITY_COLORS[label] ?? "bg-gray-200 dark:bg-gray-700";

type AnonymiseSidebarProps = {
  fieldId: string;
  onClose: () => void;
};

export const AnonymiseSidebar = ({
  fieldId,
  onClose,
}: AnonymiseSidebarProps) => {
  const t = useTranslations();
  const entities = useAnonymiseOverlayStore(
    useShallow((s) => s.files.get(fieldId)?.entities ?? []),
  );
  const removeEntity = useAnonymiseOverlayStore((s) => s.removeEntity);
  const relabelEntity = useAnonymiseOverlayStore((s) => s.relabelEntity);
  const addEntityByText = useAnonymiseOverlayStore((s) => s.addEntityByText);

  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState("");
  const [addLabel, setAddLabel] = useState<string>(
    LABEL_OPTIONS[0] ?? "person",
  );
  const [noMatches, setNoMatches] = useState(false);

  const handleAdd = () => {
    const trimmed = addText.trim();
    if (!trimmed) {
      return;
    }
    const count = addEntityByText(fieldId, trimmed, addLabel);
    if (count === 0) {
      setNoMatches(true);
      return;
    }
    setNoMatches(false);
    setAddText("");
    setAdding(false);
  };

  return (
    <div className="flex w-64 shrink-0 flex-col border-s">
      {/* Header */}
      <div
        className={cn(
          "flex items-center justify-between border-b px-2",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <span className="text-[10px] font-medium">
          {t("anonymise.entities")} ({entities.length})
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setAdding(!adding)}
            title={t("anonymise.addEntity")}
          >
            <PlusIcon className="size-3.5" />
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={onClose}>
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Add entity form */}
      {adding && (
        <div className="flex flex-col gap-1.5 border-b p-2">
          <input
            className="bg-muted rounded border px-2 py-1 text-[10px]"
            placeholder={t("anonymise.searchPlaceholder")}
            value={addText}
            onChange={(e) => {
              setAddText(e.target.value);
              setNoMatches(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleAdd();
              }
              if (e.key === "Escape") {
                setAdding(false);
              }
            }}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
          <div className="flex items-center gap-1">
            <select
              className="bg-muted flex-1 rounded px-1 py-0.5 text-[10px]"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
            >
              {LABEL_OPTIONS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              onClick={handleAdd}
              disabled={!addText.trim()}
            >
              {t("anonymise.confirm")}
            </Button>
          </div>
          {noMatches && (
            <span className="text-destructive text-[10px]">
              {t("anonymise.noEntitiesFound")}
            </span>
          )}
        </div>
      )}

      {/* Entity list */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 p-1.5">
          {entities.length === 0 && (
            <div className="text-muted-foreground p-2 text-center text-[10px]">
              {t("anonymise.noEntitiesFound")}
            </div>
          )}
          {entities.map((e) => (
            <div key={e.id} className="rounded border p-1.5 text-[10px]">
              <div className="flex items-start justify-between gap-1">
                <span
                  className={cn(
                    colorFor(e.label),
                    "truncate rounded px-1 font-mono",
                  )}
                  title={e.text}
                >
                  {e.text}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => removeEntity(fieldId, e.id)}
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
              <div className="mt-1">
                <select
                  className="bg-muted rounded px-1 py-0.5 text-[10px]"
                  value={e.label}
                  onChange={(ev) =>
                    relabelEntity(fieldId, e.id, ev.target.value)
                  }
                >
                  {LABEL_OPTIONS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};
