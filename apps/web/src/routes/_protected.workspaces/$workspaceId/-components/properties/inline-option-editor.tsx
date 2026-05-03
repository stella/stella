import { useState } from "react";

import type { OptionColor } from "@stll/api/types";
import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { CircleDotIcon, PlusIcon, TagsIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { WorkspacePropertyOption } from "@/lib/types";
import { SelectFallback } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/select-fallback";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import {
  optionColors,
  resolveOptionColor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/utils";

const colorAt = (index: number): OptionColor =>
  optionColors[index % optionColors.length] ?? "gray";

type InlineOptionEditorProps = {
  type: "single-select" | "multi-select";
  options: WorkspacePropertyOption[];
  pushOption: (option: WorkspacePropertyOption) => void;
  removeOptionAt: (index: number) => void;
  replaceOptionAt: (index: number, option: WorkspacePropertyOption) => void;
  fallback: string | null;
  onFallbackChange: (next: string | null) => void;
};

export const InlineOptionEditor = ({
  type,
  options,
  pushOption,
  removeOptionAt,
  replaceOptionAt,
  fallback,
  onFallbackChange,
}: InlineOptionEditorProps) => {
  const t = useTranslations();
  const [draft, setDraft] = useState("");
  const isMulti = type === "multi-select";
  const HeaderIcon = isMulti ? TagsIcon : CircleDotIcon;

  const addFromDraft = () => {
    const value = draft.trim();
    if (value.length === 0) {
      return;
    }
    if (options.some((o) => o.value === value)) {
      setDraft("");
      return;
    }
    pushOption({ value, color: colorAt(options.length) });
    setDraft("");
  };

  const renameAt = (index: number, value: string) => {
    const existing = options[index];
    if (!existing || existing.value === value) {
      return;
    }
    replaceOptionAt(index, { ...existing, value });
  };

  return (
    <div className="bg-muted/64 flex flex-col gap-2 rounded-[9px] border p-3">
      <div className="flex items-center gap-1.5">
        <HeaderIcon className="text-muted-foreground size-2.5" />
        <span className="text-muted-foreground text-[11px] font-medium tracking-[0.08em] uppercase">
          {isMulti
            ? t("workspaces.properties.multiOptionsTitle")
            : t("workspaces.properties.singleOptionsTitle")}
        </span>
        <span className="text-muted-foreground/72 ms-1 text-[11px]">
          {isMulti
            ? t("workspaces.properties.multiOptionsHelp")
            : t("workspaces.properties.singleOptionsHelp")}
        </span>
      </div>

      {options.length > 0 && (
        <ul className="flex flex-col gap-1">
          {options.map((option, index) => (
            <OptionRow
              index={index}
              key={`${option.value}-${index}`}
              onPickColor={(color) =>
                replaceOptionAt(index, { ...option, color })
              }
              onRemove={() => removeOptionAt(index)}
              onRename={(next) => renameAt(index, next)}
              option={option}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1.5 rounded-[7px] border border-dashed py-1 ps-1 pe-1.5">
        <Button
          aria-label={t("workspaces.properties.addOptionPressEnter")}
          className="text-muted-foreground/72 size-6 shrink-0"
          onClick={addFromDraft}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <PlusIcon className="size-3" />
        </Button>
        <input
          className="placeholder:text-muted-foreground/72 flex-1 bg-transparent text-sm focus-visible:outline-none"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addFromDraft();
            }
          }}
          placeholder={t("workspaces.properties.addOptionPressEnter")}
          value={draft}
        />
        <button
          aria-label={t("workspaces.properties.addOptionPressEnter")}
          className="text-muted-foreground/72 hover:text-foreground rounded-sm border px-1.5 py-px text-[10px] leading-none transition-colors"
          onClick={addFromDraft}
          type="button"
        >
          ↵
        </button>
      </div>

      {options.length > 0 && (
        <SelectFallback
          onValueChange={onFallbackChange}
          options={options}
          value={fallback}
        />
      )}

      <p className="text-muted-foreground/72 text-[11px]">
        {isMulti
          ? t("workspaces.properties.multiOptionsFooter")
          : t("workspaces.properties.singleOptionsFooter")}
      </p>
    </div>
  );
};

type OptionRowProps = {
  option: WorkspacePropertyOption;
  index: number;
  onPickColor: (color: OptionColor) => void;
  onRemove: () => void;
  onRename: (next: string) => void;
};

const OptionRow = ({
  option,
  onPickColor,
  onRemove,
  onRename,
}: OptionRowProps) => {
  const t = useTranslations();
  const [draft, setDraft] = useState(option.value);

  return (
    <li className="bg-card group flex items-center gap-2 rounded-[7px] border py-1 ps-1 pe-1.5">
      <Popover modal>
        <PopoverTrigger
          aria-label={t("workspaces.properties.selectColor")}
          render={<Button size="icon-sm" type="button" variant="ghost" />}
        >
          <span
            className="size-4 rounded-[5px]"
            style={{ backgroundColor: resolveOptionColor(option.color).color }}
          />
        </PopoverTrigger>
        <PopoverPopup
          className="*:data-[slot=popover-viewport]:p-1!"
          side="top"
        >
          <div className="grid grid-cols-8 gap-0.5">
            {optionColors.map((color) => (
              <PopoverClose
                key={color}
                render={
                  <Button
                    data-pressed={color === option.color ? true : undefined}
                    onClick={() => {
                      if (color !== option.color) {
                        onPickColor(color);
                      }
                    }}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  />
                }
              >
                <SelectColorIcon color={color} />
              </PopoverClose>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
      <input
        className="flex-1 bg-transparent text-sm focus-visible:outline-none"
        onBlur={() => onRename(draft.trim())}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onRename(draft.trim());
            e.currentTarget.blur();
          }
        }}
        value={draft}
      />
      <Button
        className="text-muted-foreground/64 size-5 opacity-0 group-hover:opacity-100"
        onClick={onRemove}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <XIcon className="size-3" />
      </Button>
    </li>
  );
};
