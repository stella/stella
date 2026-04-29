import { useState } from "react";

import { Field } from "@base-ui/react/field";
import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { FieldError } from "@stella/ui/components/field";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";

import type { WorkspacePropertyOption } from "@/lib/types";
import { shuffleArray } from "@/lib/utils";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import {
  optionColors,
  resolveOptionColor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/utils";

type SelectOptionsProps = {
  fieldName: string;
  options: WorkspacePropertyOption[];
  removeValue: (index: number) => void;
  pushValue: (value: WorkspacePropertyOption) => void;
  replaceValue: (index: number, value: WorkspacePropertyOption) => void;
};

export const SelectOptions = (props: SelectOptionsProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");

  const matchingOptions = props.options
    .filter((option) =>
      option.value.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    )
    .toSorted((a, b) => a.value.localeCompare(b.value));

  const onAddOption = () => {
    const duplicates = matchingOptions.filter((o) => o.value === search);

    const suffix = duplicates.length === 0 ? "" : ` (${duplicates.length})`;

    const uniqueColor =
      shuffleArray(optionColors).find(
        (c) => !props.options.some((v) => v.color === c),
      ) ?? "gray";

    props.pushValue({ color: uniqueColor, value: search + suffix });
    setSearch("");
  };

  return (
    <div className="flex w-full flex-col gap-y-0.5">
      <SearchOptions
        onAddOption={onAddOption}
        placeholder={t("workspaces.properties.searchOrAddOptions")}
        search={search}
        setSearch={setSearch}
      />
      <SelectOptionsValues
        {...props}
        createOptionLabel={t("workspaces.properties.createOption", {
          option: search,
        })}
        matchingOptions={matchingOptions}
        onAddOption={onAddOption}
        search={search}
      />
    </div>
  );
};

type SearchOptionsProps = {
  search: string;
  setSearch: (search: string) => void;
  onAddOption: () => void;
  placeholder: string;
};

const SearchOptions = ({
  search,
  setSearch,
  onAddOption,
  placeholder,
}: SearchOptionsProps) => (
  <div className="bg-muted flex w-full items-center gap-x-1.5 rounded-md px-1.5 py-1">
    <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
    <input
      className="placeholder:text-muted-foreground/72 w-full text-sm focus-within:outline-none"
      onChange={(e) => setSearch(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onAddOption();
        }
      }}
      placeholder={placeholder}
      type="text"
      value={search}
    />
  </div>
);

type SelectOptionsValuesProps = SelectOptionsProps & {
  search: string;
  onAddOption: () => void;
  matchingOptions: WorkspacePropertyOption[];
  createOptionLabel: string;
};

const SelectOptionsValues = ({
  fieldName,
  options,
  search,
  removeValue,
  replaceValue,
  onAddOption,
  matchingOptions,
  createOptionLabel,
}: SelectOptionsValuesProps) => {
  const t = useTranslations();
  const showOptions = options.length > 0;

  return (
    <Field.Root name={fieldName}>
      {showOptions && (
        <ul className="flex flex-col gap-y-1">
          {matchingOptions.map((option) => (
            <li
              className="group flex items-center justify-between"
              key={option.value}
            >
              <div className="flex items-center gap-x-0.5">
                <Popover modal>
                  <PopoverTrigger
                    aria-label={t("workspaces.properties.selectColor")}
                    render={<Button size="icon-sm" variant="ghost" />}
                  >
                    <span
                      className="size-4 rounded"
                      style={{
                        backgroundColor: resolveOptionColor(option.color).color,
                      }}
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
                              data-pressed={
                                color === option.color ? true : undefined
                              }
                              onClick={() => {
                                if (color === option.color) {
                                  return;
                                }

                                const index = options.findIndex(
                                  (o) => o.value === option.value,
                                );
                                replaceValue(index, {
                                  color,
                                  value: option.value,
                                });
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
                <span className="text-sm font-medium">{option.value}</span>
              </div>
              <Button
                className="opacity-0 group-hover:opacity-100"
                onClick={() => {
                  const index = options.findIndex(
                    (o) => o.value === option.value,
                  );
                  removeValue(index);
                }}
                size="icon-sm"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {search && options.length < optionColors.length && (
        <Button
          className="justify-start px-1!"
          onClick={onAddOption}
          size="sm"
          variant="ghost"
        >
          <PlusIcon /> {createOptionLabel}
        </Button>
      )}
      <FieldError />
    </Field.Root>
  );
};
