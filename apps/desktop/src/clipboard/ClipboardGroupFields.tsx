import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { ColorPickerContent } from "@stll/ui/color-picker";
import { Input } from "@stll/ui/input";

import {
  CLIPBOARD_GROUP_COLOR_PRESETS,
  DEFAULT_CLIPBOARD_GROUP_COLOR,
} from "./clipboard-style";
import { isClipboardGroupColor } from "./clipboard-types";
import type { ClipboardGroup, ClipboardGroupColor } from "./clipboard-types";

const MAX_GROUP_NAME_CHARACTERS = 64;

export type ClipboardGroupDraft = {
  color: ClipboardGroupColor;
  name: string;
};

type ClipboardGroupFieldsProps = ClipboardGroupDraft & {
  autoFocus: boolean;
  onChange: (fields: ClipboardGroupDraft) => void;
};

/** Name and accent of a group, shared by the timeline dialogs and the editor. */
export const ClipboardGroupFields = ({
  autoFocus,
  color,
  name,
  onChange,
}: ClipboardGroupFieldsProps) => {
  const t = useTranslations("clipboard");
  return (
    <>
      <label className="block">
        <span className="text-muted-foreground text-sm">{t("groupName")}</span>
        <Input
          autoFocus={autoFocus}
          className="mt-2 h-11 rounded-2xl text-base sm:text-base **:[input]:h-full **:[input]:px-4"
          onChange={(event) => {
            if (
              Array.from(event.target.value).length > MAX_GROUP_NAME_CHARACTERS
            ) {
              return;
            }
            onChange({ color, name: event.target.value });
          }}
          value={name}
        />
      </label>
      <fieldset className="mt-4">
        <legend className="text-muted-foreground text-sm">
          {t("groupColor")}
        </legend>
        <div className="mt-2 overflow-visible px-0.5 py-1">
          <ColorPickerContent
            moreLabel={t("customColor")}
            onSelect={(value) => {
              const picked = `#${value.toLowerCase()}`;
              if (!isClipboardGroupColor(picked)) {
                panic(
                  "Color picker returned an invalid clipboard group color.",
                );
              }
              onChange({ color: picked, name });
            }}
            presets={CLIPBOARD_GROUP_COLOR_PRESETS.map((preset) => ({
              color: preset,
              label: preset.toUpperCase(),
              value: preset.slice(1).toUpperCase(),
            }))}
            presentation="inline"
            value={color.slice(1).toUpperCase()}
          />
        </div>
      </fieldset>
    </>
  );
};

/** The accent a new group opens with: the preset after the groups in use. */
export const nextClipboardGroupColor = (
  groups: readonly ClipboardGroup[],
): ClipboardGroupColor =>
  CLIPBOARD_GROUP_COLOR_PRESETS.at(
    groups.length % CLIPBOARD_GROUP_COLOR_PRESETS.length,
  ) ?? DEFAULT_CLIPBOARD_GROUP_COLOR;
