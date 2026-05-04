import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { useTranslations } from "use-intl";

import type { ChatPrompt, PromptScope } from "@/lib/prompts/types";

const SCOPE_ORDER: PromptScope[] = ["private", "team"];

const useScopeLabel = () => {
  const t = useTranslations();
  return (scope: PromptScope): string => {
    switch (scope) {
      case "stock":
        return t("chat.prompts.scope.stock");
      case "team":
        return t("chat.prompts.scope.team");
      case "private":
        return t("chat.prompts.scope.private");
      default:
        return scope;
    }
  };
};

const groupByScope = (
  items: ChatPrompt[],
): { scope: PromptScope; items: ChatPrompt[] }[] => {
  const groups = new Map<PromptScope, ChatPrompt[]>();

  for (const item of items) {
    const list = groups.get(item.scope);
    if (list) {
      list.push(item);
    } else {
      groups.set(item.scope, [item]);
    }
  }

  const result: { scope: PromptScope; items: ChatPrompt[] }[] = [];
  for (const scope of SCOPE_ORDER) {
    const group = groups.get(scope);
    if (group && group.length > 0) {
      result.push({ scope, items: group });
    }
  }
  return result;
};

export const PromptSlashList = forwardRef<
  ReturnType<NonNullable<SuggestionOptions["render"]>>,
  SuggestionProps<ChatPrompt>
>(({ items, command, decorationNode }, ref) => {
  const t = useTranslations();
  const scopeLabel = useScopeLabel();
  const [isOpen, setIsOpen] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const safeIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

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
    const item = items[index];
    if (item) {
      command(item);
    }
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (items.length === 0) {
        return false;
      }
      if (event.key === "ArrowUp") {
        setSelectedIndex(
          (current) => (current + items.length - 1) % items.length,
        );
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((current) => (current + 1) % items.length);
        return true;
      }
      if (event.key === "Enter") {
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

  if (items.length === 0) {
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
  const groups = groupByScope(items);

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
            <div key={group.scope}>
              <div className="text-muted-foreground px-2 py-1 text-[11px] font-medium tracking-wide uppercase">
                {scopeLabel(group.scope)}
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
                    key={item.id}
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
                      {item.name}
                    </p>
                    <p className="text-muted-foreground line-clamp-2 text-[11px] leading-snug">
                      {item.body}
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
});

PromptSlashList.displayName = "PromptSlashList";
