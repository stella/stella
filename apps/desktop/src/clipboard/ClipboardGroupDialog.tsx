import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Label } from "@stll/ui/label";

import { isClipboardGroupDialogReady } from "./clipboard-settings";
import type { ClipboardGroupDialogState } from "./clipboard-settings";
import { ClipboardGroupFields } from "./ClipboardGroupFields";

/*
 * Creating, editing and deleting a group, in the Clips window and in
 * Settings alike: the same fields, the same choice of what happens to a
 * deleted group's clips, and the same title and submit label. Each window
 * draws the dialog around them in its own style.
 */

/** What the dialog around a group form shows and how its submit behaves. */
export type ClipboardGroupDialogFrame = {
  destructive: boolean;
  /** Whether closing would discard a choice the user made. */
  dirty: boolean;
  submitDisabled: boolean;
  submitLabel: string;
  title: string;
};

export const useClipboardGroupDialogFrame = (
  dialog: ClipboardGroupDialogState,
): ClipboardGroupDialogFrame => {
  const t = useTranslations("clipboard");
  const submitDisabled = !isClipboardGroupDialogReady(dialog);
  switch (dialog.type) {
    case "createGroup":
      return {
        destructive: false,
        dirty: false,
        submitDisabled,
        submitLabel: t("create"),
        title: t("createGroup"),
      };
    case "editGroup":
      return {
        destructive: false,
        dirty: false,
        submitDisabled,
        submitLabel: t("editGroup"),
        title: t("editGroup"),
      };
    case "deleteGroup":
      return {
        destructive: true,
        dirty: dialog.mode !== "keepClips",
        submitDisabled,
        submitLabel:
          dialog.mode === "deleteClips"
            ? t("deleteGroupDeleteClips")
            : t("deleteGroup"),
        title: t("deleteGroup"),
      };
    default: {
      dialog satisfies never;
      return panic(`Unhandled group dialog: ${String(dialog)}`);
    }
  }
};

/** The body of a group dialog: name and colour, or what happens to the
 *  clips of a group being deleted. */
export const ClipboardGroupDialogBody = ({
  dialog,
  onChange,
}: {
  dialog: ClipboardGroupDialogState;
  onChange: (dialog: ClipboardGroupDialogState) => void;
}) => {
  const t = useTranslations("clipboard");
  switch (dialog.type) {
    case "createGroup":
    case "editGroup":
      return (
        <ClipboardGroupFields
          autoFocus
          color={dialog.color}
          name={dialog.name}
          onChange={({ color, name }) => {
            onChange({ ...dialog, color, name });
          }}
        />
      );
    case "deleteGroup":
      return (
        <fieldset>
          <legend className="text-muted-foreground text-sm leading-relaxed text-pretty">
            {t("deleteGroupConfirmation", { groupName: dialog.groupName })}
          </legend>
          <div className="mt-4 grid gap-2">
            {(
              [
                {
                  description: t("deleteGroupKeepClipsDescription"),
                  label: t("deleteGroupKeepClips"),
                  mode: "keepClips",
                },
                {
                  description: t("deleteGroupDeleteClipsDescription"),
                  label: t("deleteGroupDeleteClips"),
                  mode: "deleteClips",
                },
              ] as const
            ).map((option) => (
              <Label
                aria-label={option.label}
                key={option.mode}
                variant="choice-card"
              >
                <input
                  checked={dialog.mode === option.mode}
                  className="accent-destructive mt-0.5 size-4 shrink-0"
                  name="delete-group-mode"
                  onChange={() => onChange({ ...dialog, mode: option.mode })}
                  type="radio"
                  value={option.mode}
                />
                <span className="min-w-0">
                  <span className="text-foreground block text-sm font-medium">
                    {option.label}
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed text-pretty">
                    {option.description}
                  </span>
                </span>
              </Label>
            ))}
          </div>
        </fieldset>
      );
    default: {
      dialog satisfies never;
      return panic(`Unhandled group dialog: ${String(dialog)}`);
    }
  }
};
