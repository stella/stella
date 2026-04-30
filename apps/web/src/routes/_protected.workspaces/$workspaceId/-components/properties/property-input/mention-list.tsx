import { forwardRef, useImperativeHandle, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { useTranslations } from "use-intl";

import type { MentionOption } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/custom-mention";

export const MentionList = forwardRef<
  ReturnType<NonNullable<SuggestionOptions["render"]>>,
  SuggestionProps<MentionOption>
>(({ items, command, decorationNode }, ref) => {
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
        setSelectedIndex((selectedIndex + 1) % items.length);
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
        <div className="flex min-w-32 flex-col gap-1">
          {items.length === 0 && (
            <div className="text-muted-foreground flex items-center justify-center p-1 text-center text-sm">
              {t("workspaces.properties.noPropertiesFound")}
            </div>
          )}
          {items.map((item, index) => (
            <Button
              className={cn(
                "justify-start font-normal",
                selectedIndex === index && "bg-accent text-accent-foreground",
              )}
              key={item.id}
              onClick={() => selectItem(index)}
              size="sm"
              variant="ghost"
            >
              {item.label}
            </Button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
});

MentionList.displayName = "MentionList";
