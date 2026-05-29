import { useImperativeHandle, useState } from "react";
import type { Ref } from "react";

import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { CommandIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

import type { SlashItem } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/slash-extension";

type SlashListHandle = ReturnType<NonNullable<SuggestionOptions["render"]>>;

type SlashListProps = SuggestionProps<SlashItem> & {
  ref?: Ref<SlashListHandle>;
};

export const SlashList = ({
  items,
  command,
  decorationNode,
  ref,
}: SlashListProps) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectItem = (index: number) => {
    const item = items.at(index);
    if (item) {
      command(item);
    }
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setIsOpen(false);
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelectedIndex((selectedIndex + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((selectedIndex + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "Enter") {
        selectItem(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  return (
    <Popover modal={true} onOpenChange={setIsOpen} open={isOpen}>
      <PopoverPopup
        align="start"
        anchor={decorationNode}
        className="*:data-[slot=popover-positioner]:transition-none! *:data-[slot=popover-viewport]:p-1!"
        initialFocus={false}
      >
        <div className="flex min-w-56 flex-col gap-0.5">
          {items.length === 0 && (
            <div className="text-muted-foreground flex items-center justify-center p-2 text-center text-xs">
              {t("workspaces.properties.slashEmpty")}
            </div>
          )}
          {items.map((item, index) => (
            <Button
              className={cn(
                "h-auto justify-start gap-2 px-2 py-1.5 font-normal",
                selectedIndex === index && "bg-accent text-accent-foreground",
              )}
              key={`${item.kind}:${item.id}`}
              onClick={() => selectItem(index)}
              size="sm"
              variant="ghost"
            >
              {item.kind === "prompt" ? (
                <CommandIcon className="text-muted-foreground size-3.5 shrink-0" />
              ) : (
                <SparklesIcon className="text-muted-foreground size-3.5 shrink-0" />
              )}
              <span className="flex flex-col items-start text-start">
                <span className="text-sm">{item.label}</span>
                <span className="text-muted-foreground text-xs">
                  {item.kind === "prompt"
                    ? t("workspaces.properties.slashKindPrompt")
                    : t("workspaces.properties.slashKindSkill")}
                </span>
              </span>
            </Button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
};
