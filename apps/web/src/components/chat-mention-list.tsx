import { useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Ref } from "react";

import { useQuery } from "@tanstack/react-query";
import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  LandmarkIcon,
  LoaderIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Popover, PopoverPopup } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import type {
  ChatMentionOption,
  ChatReferenceCategory,
  ChatWorkspaceMentionOption,
} from "@/components/chat-mention-extension";
import { toChatMentionNodeAttrs } from "@/components/chat-mention-node-attrs";
import { MatterIcon } from "@/components/matter-icon";
import { EntityIcon } from "@/components/workspaces/entity-kind-icon";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { TranslationKey } from "@/i18n/types";
import { toSafeId } from "@/lib/safe-id";

export const ChatMentionList = ({
  items,
  command,
  clientRect,
  loadWorkspaceEntities,
  query,
  ref,
}: ChatMentionListProps) => {
  const t = useTranslations();
  const categoryLabel = useCategoryLabel();
  const [isOpen, setIsOpen] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [drillTarget, setDrillTarget] = useState<DrillTarget | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastClientRectRef = useRef<DOMRect | null>(null);
  const latestClientRect = clientRect?.() ?? null;
  if (latestClientRect) {
    // eslint-disable-next-line react/refs -- retains the last non-null caret rect so the Floating UI anchor keeps its position when clientRect() momentarily returns null
    lastClientRectRef.current = latestClientRect;
  }
  // Stable virtual-anchor identity for the Base UI positioner (Floating UI).
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => {
        const nextClientRect = clientRect?.() ?? null;
        if (nextClientRect) {
          lastClientRectRef.current = nextClientRect;
          return nextClientRect;
        }

        return lastClientRectRef.current ?? new DOMRect();
      },
    }),
    [clientRect],
  );

  const drillDownQuery = useQuery({
    queryKey: [
      "chat-mention-entities",
      drillTarget,
      query,
      loadWorkspaceEntities,
    ],
    queryFn: async () => {
      if (drillTarget === null) {
        return [];
      }
      return await loadWorkspaceEntities(
        {
          resource: resourceRef({
            type: RESOURCE_TYPE.WORKSPACE,
            id: toSafeId<"workspace">(drillTarget.workspaceId),
          }),
          label: drillTarget.name,
          category: "workspace",
          kind: "workspace",
          mimeType: null,
          sourceViewId: drillTarget.viewId,
        },
        query,
      );
    },
    enabled: drillTarget !== null,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const drillState: DrillState = (() => {
    if (drillTarget === null) {
      return { kind: "none" };
    }
    if (drillDownQuery.isError) {
      return { kind: "error", target: drillTarget };
    }
    if (drillDownQuery.isSuccess) {
      return {
        kind: "loaded",
        target: drillTarget,
        items: drillDownQuery.data,
      };
    }
    return { kind: "loading", target: drillTarget };
  })();

  const drillItems = drillState.kind === "loaded" ? drillState.items : [];
  const activeItems = drillTarget ? drillItems : items;
  const safeIndex = Math.min(
    selectedIndex,
    Math.max(0, activeItems.length - 1),
  );

  // Scroll the selected item into view on index change
  useExternalSyncEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-mention-index="${safeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [safeIndex]);

  const selectItem = (index: number) => {
    const item = activeItems.at(index);
    if (item !== undefined) {
      command(toChatMentionNodeAttrs(item));
    }
  };

  const handleDrillDown = (workspace: ChatWorkspaceMentionOption) => {
    if (!workspace.sourceViewId) {
      return;
    }

    setDrillTarget({
      workspaceId: workspace.resource.id,
      viewId: workspace.sourceViewId,
      name: workspace.label,
    });
    setSelectedIndex(0);
  };

  const handleBack = () => {
    setDrillTarget(null);
    setSelectedIndex(0);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "Escape") {
        if (drillTarget) {
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

      if (
        event.key === "Tab" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        activeItems.length > 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        selectItem(safeIndex);
        return true;
      }

      // The drill-down chevron mirrors under RTL (DirectionalIcon), so the
      // horizontal arrows must follow visual direction: the key pointing
      // "into" the group is ArrowRight under LTR and ArrowLeft under RTL.
      // Read the rendered list's computed direction so this stays correct
      // regardless of how the host app or an enclosing subtree sets `dir`.
      const isRtl =
        listRef.current !== null &&
        getComputedStyle(listRef.current).direction === "rtl";
      const drillInKey = isRtl ? "ArrowLeft" : "ArrowRight";
      const drillOutKey = isRtl ? "ArrowRight" : "ArrowLeft";

      // The inline-forward arrow on a workspace item drills down
      if (event.key === drillInKey && !drillTarget) {
        const item = activeItems.at(safeIndex);
        if (item?.category === "workspace") {
          handleDrillDown(item);
          return true;
        }
      }

      // The inline-back arrow exits drill-down
      if (event.key === drillOutKey && drillTarget) {
        handleBack();
        return true;
      }

      return false;
    },
  }));

  const groups = groupByCategory(activeItems);
  const hasMultipleCategories = groups.length > 1;

  // eslint-disable-next-line react/refs -- reads the retained last-known caret rect (written above from this render's clientRect) to gate the positioner; the ref persists the value across renders where clientRect() returns null
  if (!lastClientRectRef.current) {
    return null;
  }

  return (
    <Popover modal={true} onOpenChange={setIsOpen} open={isOpen}>
      <PopoverPopup
        align="start"
        anchor={anchor}
        className="w-96 max-w-[min(24rem,calc(100vw-2rem))] *:data-[slot=popover-positioner]:transition-none! *:data-[slot=popover-viewport]:p-1!"
        initialFocus={false}
        side="top"
      >
        <div
          className="flex max-h-64 w-full min-w-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto"
          ref={listRef}
        >
          {drillTarget && (
            <Button
              className="text-muted-foreground justify-start gap-2 font-normal"
              onClick={handleBack}
              size="sm"
              variant="ghost"
            >
              <DirectionalIcon
                className="size-3.5 shrink-0"
                icon={ArrowLeftIcon}
              />
              <MatterIcon
                className="size-3.5 shrink-0"
                matter={{ id: drillTarget.workspaceId, color: null }}
              />
              <span className="truncate">{drillTarget.name}</span>
            </Button>
          )}

          {drillState.kind === "loading" && (
            <div className="flex items-center justify-center p-2">
              <LoaderIcon className="text-muted-foreground size-4 animate-spin" />
            </div>
          )}

          {drillState.kind === "error" && (
            <div className="text-destructive flex items-center justify-center p-2 text-center text-sm">
              {t("chat.mention.loadError")}
            </div>
          )}

          {drillState.kind === "none" && activeItems.length === 0 && (
            <div className="text-muted-foreground flex items-center justify-center p-2 text-center text-sm">
              {t("common.noResults")}
            </div>
          )}

          {drillState.kind === "loaded" && drillState.items.length === 0 && (
            <div className="text-muted-foreground flex items-center justify-center p-2 text-center text-sm">
              {t("common.noResults")}
            </div>
          )}

          {drillState.kind === "none" &&
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
                        key={item.resource.id}
                      >
                        <Button
                          className={cn(
                            "min-w-0 flex-1 justify-start gap-2 overflow-hidden font-normal",
                            safeIndex === flatIndex &&
                              "bg-accent text-accent-foreground",
                          )}
                          key={item.resource.id}
                          onClick={() => selectItem(flatIndex)}
                          size="sm"
                          variant="ghost"
                        >
                          <MentionIcon mention={item} />
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                          </span>
                        </Button>
                        {isWorkspace && (
                          <Button
                            aria-label={t("common.open")}
                            className="text-muted-foreground size-7 shrink-0"
                            onClick={() => handleDrillDown(item)}
                            size="icon-sm"
                            variant="ghost"
                          >
                            <DirectionalIcon
                              className="size-3.5"
                              icon={ChevronRightIcon}
                            />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}

          {drillState.kind === "loaded" &&
            drillState.items.map((item, i) => (
              <Button
                className={cn(
                  "min-w-0 justify-start gap-2 overflow-hidden font-normal",
                  safeIndex === i && "bg-accent text-accent-foreground",
                )}
                data-mention-index={i}
                key={item.resource.id}
                onClick={() => selectItem(i)}
                size="sm"
                variant="ghost"
              >
                <MentionIcon mention={item} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </Button>
            ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
};

const CATEGORY_LABEL_KEYS = {
  entity: "chat.mention.category.entities",
  workspace: "common.matters",
  decision: "common.caseLaw",
} as const satisfies Record<ChatReferenceCategory, TranslationKey>;

const CATEGORY_ORDER = [
  "entity",
  "workspace",
  "decision",
] as const satisfies readonly ChatReferenceCategory[];

type MissingCategory = Exclude<
  ChatReferenceCategory,
  (typeof CATEGORY_ORDER)[number]
>;

true satisfies MissingCategory extends never ? true : never;

const useCategoryLabel = () => {
  const t = useTranslations();
  return (category: ChatReferenceCategory): string =>
    t(CATEGORY_LABEL_KEYS[category]);
};

/** Resolves the category/kind-appropriate glyph for a mention row. Exported
 *  so the composer (+) menu's Context submenu can render byte-identical
 *  icons for the same options the "@" popover lists. */
export const MentionIcon = ({ mention }: { mention: ChatMentionOption }) => {
  if (mention.category === "workspace") {
    return (
      <MatterIcon
        className="size-3.5 shrink-0"
        matter={{ id: mention.resource.id, color: null }}
      />
    );
  }

  if (mention.category === "decision") {
    return <LandmarkIcon className="text-muted-foreground size-3.5 shrink-0" />;
  }

  return (
    <EntityIcon
      className="text-muted-foreground size-3.5 shrink-0"
      source={{
        type: "resolved",
        kind: mention.kind,
        mimeType: mention.mimeType,
      }}
    />
  );
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

type DrillTarget = {
  workspaceId: string;
  viewId: string;
  name: string;
};

type DrillState =
  | { kind: "none" }
  | { kind: "loading"; target: DrillTarget }
  | { kind: "loaded"; target: DrillTarget; items: ChatMentionOption[] }
  | { kind: "error"; target: DrillTarget };

type ChatMentionListHandle = ReturnType<
  NonNullable<SuggestionOptions["render"]>
>;

type ChatMentionListProps = SuggestionProps<
  ChatMentionOption,
  MentionNodeAttrs
> & {
  loadWorkspaceEntities: (
    workspace: ChatWorkspaceMentionOption,
    query: string,
  ) => Promise<ChatMentionOption[]>;
  ref?: Ref<ChatMentionListHandle>;
};
