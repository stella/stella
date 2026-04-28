import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  LandmarkIcon,
  LayersIcon,
  LoaderIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Popover, PopoverPopup } from "@stella/ui/components/popover";
import { cn } from "@stella/ui/lib/utils";

import type {
  ChatMentionOption,
  ChatReferenceCategory,
} from "@/components/chat-mention-extension";
import { getMatterColor } from "@/lib/matter-colors";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

const CATEGORY_ORDER: ChatReferenceCategory[] = [
  "entity",
  "workspace",
  "decision",
];

const useCategoryLabel = () => {
  const t = useTranslations();
  return (category: ChatReferenceCategory): string => {
    switch (category) {
      case "entity":
        return t("chat.mention.category.entities");
      case "workspace":
        return t("chat.mention.category.matters");
      case "decision":
        return t("common.caseLaw");
      default:
        return category;
    }
  };
};

const MentionIcon = ({
  id,
  category,
  kind,
  mimeType,
}: {
  id: string;
  category: ChatReferenceCategory;
  kind: string;
  mimeType: string | null;
}) => {
  const cls = "size-3.5 shrink-0 text-muted-foreground";

  if (category === "workspace") {
    return (
      <LayersIcon
        className="size-3.5 shrink-0"
        style={{ color: getMatterColor(id) }}
      />
    );
  }

  if (category === "decision") {
    return <LandmarkIcon className={cls} />;
  }

  // Entity category: use document/folder icons
  if (kind === "folder") {
    return <FolderIcon className={cls} />;
  }
  if (mimeType) {
    return <DocumentIcon className="size-3.5 shrink-0" mimeType={mimeType} />;
  }
  return <FileTextIcon className={cls} />;
};

/** Group items by category, preserving a stable order. */
const groupByCategory = (
  items: ChatMentionOption[],
): { category: ChatReferenceCategory; items: ChatMentionOption[] }[] => {
  const groups = new Map<ChatReferenceCategory, ChatMentionOption[]>();

  for (const item of items) {
    const list = groups.get(item.category);
    if (list) {
      list.push(item);
    } else {
      groups.set(item.category, [item]);
    }
  }

  const result: {
    category: ChatReferenceCategory;
    items: ChatMentionOption[];
  }[] = [];

  for (const cat of CATEGORY_ORDER) {
    const group = groups.get(cat);
    if (group && group.length > 0) {
      result.push({ category: cat, items: group });
    }
  }

  return result;
};

type DrillDownState = {
  workspaceId: string;
  viewId: string;
  name: string;
};

export const ChatMentionList = forwardRef<
  ReturnType<NonNullable<SuggestionOptions["render"]>>,
  SuggestionProps<ChatMentionOption> & {
    loadWorkspaceEntities: (
      workspace: ChatMentionOption,
    ) => Promise<ChatMentionOption[]>;
  }
>(({ items, command, decorationNode, loadWorkspaceEntities }, ref) => {
  const t = useTranslations();
  const categoryLabel = useCategoryLabel();
  const [isOpen, setIsOpen] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [drillDown, setDrillDown] = useState<DrillDownState | null>(null);
  const [drillDownItems, setDrillDownItems] = useState<ChatMentionOption[]>([]);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [entitiesError, setEntitiesError] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const activeItems = drillDown ? drillDownItems : items;
  const safeIndex = Math.min(
    selectedIndex,
    Math.max(0, activeItems.length - 1),
  );

  useEffect(() => {
    if (drillDown === null) {
      setDrillDownItems([]);
      setEntitiesLoading(false);
      setEntitiesError(false);
      return undefined;
    }

    let cancelled = false;
    setEntitiesLoading(true);
    setEntitiesError(false);

    void loadWorkspaceEntities({
      id: drillDown.workspaceId,
      label: drillDown.name,
      category: "workspace",
      kind: "workspace",
      mimeType: null,
      sourceViewId: drillDown.viewId,
    })
      .then((nextItems) => {
        if (cancelled) {
          return;
        }

        setDrillDownItems(nextItems);
        setEntitiesLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setDrillDownItems([]);
        setEntitiesError(true);
        setEntitiesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [drillDown, loadWorkspaceEntities]);

  // Scroll the selected item into view on index change
  useEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-mention-index="${safeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [safeIndex]);

  const selectItem = (index: number) => {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
    const item = activeItems.at(index);
    if (item !== undefined) {
      command(item);
    }
  };

  const handleDrillDown = (workspace: ChatMentionOption) => {
    if (!workspace.sourceViewId) {
      return;
    }

    setDrillDown({
      workspaceId: workspace.id,
      viewId: workspace.sourceViewId,
      name: workspace.label,
    });
    setSelectedIndex(0);
  };

  const handleBack = () => {
    setDrillDown(null);
    setSelectedIndex(0);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "Escape") {
        if (drillDown) {
          handleBack();
          return true;
        }
        event.stopPropagation();
        setIsOpen(false);
        return true;
      }

      if (event.key === "ArrowUp") {
        if (activeItems.length > 0) {
          setSelectedIndex(
            (safeIndex + activeItems.length - 1) % activeItems.length,
          );
        }
        return true;
      }

      if (event.key === "ArrowDown") {
        if (activeItems.length > 0) {
          setSelectedIndex((safeIndex + 1) % activeItems.length);
        }
        return true;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        selectItem(safeIndex);
        return true;
      }

      // ArrowRight on a workspace item drills down
      if (event.key === "ArrowRight" && !drillDown) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
        const item = activeItems.at(safeIndex);
        if (item?.category === "workspace") {
          handleDrillDown(item);
          return true;
        }
      }

      // ArrowLeft exits drill-down
      if (event.key === "ArrowLeft" && drillDown) {
        handleBack();
        return true;
      }

      return false;
    },
  }));

  const groups = groupByCategory(activeItems);
  const hasMultipleCategories = groups.length > 1;

  return (
    <Popover modal={true} onOpenChange={setIsOpen} open={isOpen}>
      <PopoverPopup
        align="start"
        anchor={decorationNode}
        className="w-96 max-w-[min(24rem,calc(100vw-2rem))] *:data-[slot=popover-positioner]:transition-none! *:data-[slot=popover-viewport]:p-1!"
        initialFocus={false}
        side="top"
      >
        <div
          className="flex max-h-64 w-full min-w-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto"
          ref={listRef}
        >
          {drillDown && (
            <Button
              className="text-muted-foreground justify-start gap-2 font-normal"
              onClick={handleBack}
              size="sm"
              variant="ghost"
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              <LayersIcon className="size-3.5 shrink-0" />
              <span className="truncate">{drillDown.name}</span>
            </Button>
          )}

          {drillDown && entitiesLoading && (
            <div className="flex items-center justify-center p-2">
              <LoaderIcon className="text-muted-foreground size-4 animate-spin" />
            </div>
          )}

          {drillDown && !entitiesLoading && entitiesError && (
            <div className="text-destructive flex items-center justify-center p-2 text-center text-sm">
              {t("chat.mention.loadError")}
            </div>
          )}

          {!drillDown && activeItems.length === 0 && (
            <div className="text-muted-foreground flex items-center justify-center p-2 text-center text-sm">
              {t("chat.mention.noResults")}
            </div>
          )}

          {drillDown && !entitiesLoading && drillDownItems.length === 0 && (
            <div className="text-muted-foreground flex items-center justify-center p-2 text-center text-sm">
              {t("chat.mention.noResults")}
            </div>
          )}

          {!drillDown &&
            groups.map((group) => {
              const firstItem = group.items[0];
              const groupStartIndex = firstItem
                ? activeItems.indexOf(firstItem)
                : -1;

              return (
                <div key={group.category}>
                  {hasMultipleCategories && (
                    <div className="text-muted-foreground px-2 pt-1.5 pb-0.5 text-xs font-medium">
                      {categoryLabel(group.category)}
                    </div>
                  )}
                  {group.items.map((item, i) => {
                    const flatIndex = groupStartIndex + i;
                    const isWorkspace = item.category === "workspace";

                    return (
                      <div
                        className="flex min-w-0 items-center"
                        data-mention-index={flatIndex}
                        key={item.id}
                      >
                        <Button
                          className={cn(
                            "min-w-0 flex-1 justify-start gap-2 overflow-hidden font-normal",
                            safeIndex === flatIndex &&
                              "bg-accent text-accent-foreground",
                          )}
                          key={item.id}
                          onClick={() => selectItem(flatIndex)}
                          size="sm"
                          variant="ghost"
                        >
                          <MentionIcon
                            category={item.category}
                            id={item.id}
                            kind={item.kind}
                            mimeType={item.mimeType}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                          </span>
                        </Button>
                        {isWorkspace && (
                          <Button
                            className="text-muted-foreground size-7 shrink-0"
                            onClick={() => handleDrillDown(item)}
                            size="icon-sm"
                            variant="ghost"
                          >
                            <ChevronRightIcon className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}

          {/* oxlint-disable typescript-eslint/no-unsafe-assignment */}
          {drillDown &&
            !entitiesLoading &&
            drillDownItems?.map((item, i) => (
              <Button
                className={cn(
                  "min-w-0 justify-start gap-2 overflow-hidden font-normal",
                  safeIndex === i && "bg-accent text-accent-foreground",
                )}
                data-mention-index={i}
                key={item.id}
                onClick={() => selectItem(i)}
                size="sm"
                variant="ghost"
              >
                <MentionIcon
                  category={item.category}
                  id={item.id}
                  kind={item.kind}
                  mimeType={item.mimeType}
                />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </Button>
            ))}
          {/* oxlint-enable typescript-eslint/no-unsafe-assignment */}
        </div>
      </PopoverPopup>
    </Popover>
  );
});

ChatMentionList.displayName = "ChatMentionList";
