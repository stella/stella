import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";

import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { useTranslations } from "use-intl";

import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

import type { SlashItem } from "@/components/chat/prompt-slash-extension";
import {
  getSlashItemsInRenderOrder,
  groupSlashItemsBySection,
  type SlashSectionKey,
} from "@/components/chat/prompt-slash-list.logic";
import type { TranslationKey } from "@/i18n/types";

// Prompts and SKILL.md skills are one user-facing concept ("skills"), so
// they share section headers grouped by scope rather than split by feed.
const SECTION_LABEL_KEYS = {
  private: "chat.skills.scope.private",
  team: "chat.skills.scope.team",
  "built-in": "knowledge.agentSkills.builtInSection",
} satisfies Record<SlashSectionKey, TranslationKey>;

const getItemKey = (item: SlashItem): string =>
  item.kind === "prompt"
    ? `prompt:${item.prompt.id}`
    : `skill:${item.skill.id}`;

const getItemName = (item: SlashItem): string =>
  item.kind === "prompt" ? item.prompt.name : item.skill.name;

const getItemSecondary = (item: SlashItem): string =>
  item.kind === "prompt" ? item.prompt.body : item.skill.description;

type PromptSlashListHandle = ReturnType<
  NonNullable<SuggestionOptions["render"]>
>;

type PromptSlashListProps = SuggestionProps<SlashItem> & {
  ref?: Ref<PromptSlashListHandle>;
};

export const PromptSlashList = ({
  items,
  command,
  decorationNode,
  ref,
}: PromptSlashListProps) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const groups = groupSlashItemsBySection(items);
  const renderedItems = getSlashItemsInRenderOrder(groups);
  const itemCount = renderedItems.length;

  const safeIndex = Math.min(selectedIndex, Math.max(0, itemCount - 1));

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  // Scroll the active item into view as keyboard nav moves it
  // outside the popup's clipping area.
  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const active = list.querySelector<HTMLElement>(
      `[data-index="${safeIndex}"]`,
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [safeIndex]);

  const select = (index: number) => {
    const item = renderedItems.at(index);
    if (item) {
      command(item);
    }
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (itemCount === 0) {
        return false;
      }
      if (event.key === "ArrowUp") {
        setSelectedIndex((current) => (current + itemCount - 1) % itemCount);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((current) => (current + 1) % itemCount);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        select(safeIndex);
        return true;
      }
      if (event.key === "Escape") {
        setIsOpen(false);
        return true;
      }
      return false;
    },
  }));

  if (itemCount === 0) {
    return (
      <Popover modal={true} onOpenChange={setIsOpen} open={isOpen}>
        <PopoverPopup
          align="start"
          anchor={decorationNode}
          className="w-72 max-w-[min(20rem,calc(100vw-2rem))] *:data-[slot=popover-viewport]:p-2!"
          initialFocus={false}
          side="top"
        >
          <p className="text-muted-foreground text-xs">
            {t("chat.prompts.noResults")}
          </p>
        </PopoverPopup>
      </Popover>
    );
  }

  let runningIndex = 0;

  return (
    <Popover modal={true} onOpenChange={setIsOpen} open={isOpen}>
      <PopoverPopup
        align="start"
        anchor={decorationNode}
        className="w-80 max-w-[min(22rem,calc(100vw-2rem))] *:data-[slot=popover-viewport]:p-1!"
        initialFocus={false}
        side="top"
      >
        <div className="max-h-72 space-y-1 overflow-y-auto" ref={listRef}>
          {groups.map((group) => (
            <div key={group.section}>
              <div className="text-muted-foreground px-2 py-1 text-[11px] font-medium tracking-wide uppercase">
                {t(SECTION_LABEL_KEYS[group.section])}
              </div>
              {group.items.map((item) => {
                const index = runningIndex++;
                const active = index === safeIndex;
                return (
                  <button
                    className={cn(
                      "block w-full rounded-sm px-2 py-1.5 text-start transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50",
                    )}
                    data-index={index}
                    key={getItemKey(item)}
                    onClick={() => select(index)}
                    onMouseDown={(event) => {
                      // Keep the editor focused so `command` can run
                      // its `editor.chain().focus()...insertContent`.
                      event.preventDefault();
                    }}
                    onMouseEnter={() => setSelectedIndex(index)}
                    type="button"
                  >
                    <p className="text-foreground text-xs font-medium">
                      {getItemName(item)}
                    </p>
                    <p className="text-muted-foreground line-clamp-2 text-[11px] leading-snug">
                      {getItemSecondary(item)}
                    </p>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
};
