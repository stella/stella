import { useId, useRef, useState } from "react";

import { panic } from "better-result";
import { PlusIcon, SplitIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/popover";
import { contentDir } from "@stll/ui/use-content-dir";

import {
  hasOptionSeparator,
  splitOptionValues,
} from "@/components/workspaces/properties/inline-option-editor.logic";
import { SelectFallback } from "@/components/workspaces/properties/select-fallback";
import { SelectColorIcon } from "@/components/workspaces/properties/shared";
import {
  optionColors,
  resolveOptionColor,
} from "@/components/workspaces/property-utils";
import type { PropertyOptionColor } from "@/lib/api-contract";
import type { SelectPropertyOption } from "@/lib/types";

const colorAt = (index: number): PropertyOptionColor =>
  optionColors[index % optionColors.length] ?? "gray";

type InlineOptionEditorProps = {
  options: SelectPropertyOption[];
  /** Several at once: a pasted list lands in one update, never one per option. */
  pushOptions: (options: SelectPropertyOption[]) => void;
  removeOptionAt: (index: number) => void;
  replaceOptionAt: (index: number, option: SelectPropertyOption) => void;
  fallback: string | null;
  /**
   * Omitted where the column has no fallback to offer: a case-law question
   * column never substitutes a default, because a decision not settling the
   * question is itself the answer.
   */
  onFallbackChange?: ((next: string | null) => void) | undefined;
};

export const InlineOptionEditor = ({
  options,
  pushOptions,
  removeOptionAt,
  replaceOptionAt,
  fallback,
  onFallbackChange,
}: InlineOptionEditorProps) => {
  const t = useTranslations();
  const [draft, setDraft] = useState("");
  const editorId = useId();
  const nextRowId = useRef(options.length);
  const [rowIds, setRowIds] = useState(() =>
    options.map((_, index) => `${editorId}-${index}`),
  );

  const allocateRowId = () => {
    const rowId = `${editorId}-${nextRowId.current}`;
    nextRowId.current += 1;
    return rowId;
  };

  const addValues = (text: string) => {
    const values = splitOptionValues({
      text,
      existing: options.map((option) => option.value),
    });
    if (values.length === 0) {
      setDraft("");
      return;
    }
    const addedRowIds = values.map(() => allocateRowId());
    setRowIds((current) => [...current, ...addedRowIds]);
    pushOptions(
      values.map((value, index) => ({
        value,
        color: colorAt(options.length + index),
      })),
    );
    setDraft("");
  };

  /** Enter keeps the draft as one option; splitting is offered, never assumed. */
  const addFromDraft = () => {
    const value = draft.trim();
    if (value.length === 0) {
      return;
    }
    if (options.some((option) => option.value === value)) {
      setDraft("");
      return;
    }
    const rowId = allocateRowId();
    setRowIds((current) => [...current, rowId]);
    pushOptions([{ value, color: colorAt(options.length) }]);
    setDraft("");
  };

  const suggestedSplit = hasOptionSeparator(draft)
    ? splitOptionValues({
        text: draft,
        existing: options.map((option) => option.value),
      })
    : [];

  const renameAt = (index: number, value: string) => {
    const existing = options[index];
    if (!existing || existing.value === value) {
      return;
    }
    replaceOptionAt(index, { ...existing, value });
  };

  const removeAt = (index: number) => {
    setRowIds((current) => current.filter((_, rowIndex) => rowIndex !== index));
    removeOptionAt(index);
  };

  return (
    <div className="bg-muted/64 flex flex-col gap-2 rounded-[9px] border p-3">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground text-2xs font-medium tracking-[0.08em] uppercase">
          {t("workspaces.properties.optionsLabel")}
        </span>
      </div>

      {options.length > 0 && (
        <ul className="flex flex-col gap-1">
          {options.map((option, index) => {
            const rowId = rowIds.at(index);
            if (!rowId) {
              return panic("Missing inline option editor row identity");
            }

            return (
              <OptionRow
                key={rowId}
                onPickColor={(color) =>
                  replaceOptionAt(index, { ...option, color })
                }
                onRemove={() => removeAt(index)}
                onRename={(next) => renameAt(index, next)}
                option={option}
              />
            );
          })}
        </ul>
      )}

      <label className="hover:bg-muted/40 flex cursor-text items-center gap-1.5 rounded-[7px] border border-dashed py-1 ps-1 pe-1.5">
        <Button
          aria-label={t("workspaces.properties.addOption")}
          className="text-foreground-label size-6 shrink-0"
          onClick={addFromDraft}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <PlusIcon className="size-3" />
        </Button>
        <input
          className="placeholder:text-foreground-placeholder flex-1 bg-transparent text-sm focus-visible:outline-none"
          dir={contentDir(draft)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addFromDraft();
            }
          }}
          placeholder={t("workspaces.properties.addOption")}
          value={draft}
        />
      </label>

      {suggestedSplit.length > 1 && (
        <Button
          className="self-start"
          onClick={() => addValues(draft)}
          size="sm"
          type="button"
          variant="outline"
        >
          <SplitIcon className="size-3.5" />
          {t("workspaces.properties.splitOptions", {
            count: suggestedSplit.length,
          })}
        </Button>
      )}

      {options.length > 0 && onFallbackChange !== undefined && (
        <SelectFallback
          onValueChange={onFallbackChange}
          options={options}
          value={fallback}
        />
      )}
    </div>
  );
};

type OptionRowProps = {
  option: SelectPropertyOption;
  onPickColor: (color: PropertyOptionColor) => void;
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
        <PopoverPopup padding="xs" side="top">
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
        dir={contentDir(draft)}
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
        aria-label={t("common.remove")}
        className="text-foreground-placeholder size-5 opacity-0 group-hover:opacity-100"
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
