import { useImperativeHandle, useState } from "react";
import type { Ref } from "react";

import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

import type { MentionOption } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/custom-mention";

type MentionListHandle = ReturnType<NonNullable<SuggestionOptions["render"]>>;

type MentionListProps = SuggestionProps<MentionOption> & {
  ref?: Ref<MentionListHandle>;
};

export const MentionList = ({
  items,
  command,
  decorationNode,
  ref,
}: MentionListProps) => {
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
};
