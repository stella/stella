import { useTranslations } from "use-intl";

import { InlineRenameInput } from "@stll/ui/inline-rename";
import { cn } from "@stll/ui/utils";

type InlineEditProps = {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  /** Extra content after the input (e.g. file extension). */
  suffix?: React.ReactNode;
  /**
   * Action button(s) after the input (e.g. a suggest wand).
   * Buttons placed here must call `preventDefault()` in `onMouseDown` and
   * trigger on `onClick`: the input commits on blur, so an unprevented
   * press's focus steal would close the editor before the action's result
   * could land in the draft, while the prevented press still emits `click`.
   */
  action?: React.ReactNode | undefined;
  /**
   * Accessible name for the field, naming what is being renamed
   * ("Document name"). Defaults to the bare "Rename" verb.
   */
  inputAriaLabel?: string | undefined;
  /** Longest value the field accepts; typing and pasting stop there. */
  maxLength?: number | undefined;
  className?: string | undefined;
  inputClassName?: string | undefined;
};

/**
 * `InlineRenameInput` plus a suffix and action slot. It adds no commit button:
 * Enter and blur commit and Escape cancels, as on every other inline rename.
 */
export const InlineEdit = ({
  value,
  onChange,
  onCommit,
  onCancel,
  suffix,
  action,
  inputAriaLabel,
  maxLength,
  className,
  inputClassName,
}: InlineEditProps) => {
  const t = useTranslations();

  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1",
        className,
      )}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (
          nextTarget instanceof Node &&
          event.currentTarget.contains(nextTarget)
        ) {
          return;
        }
        onCommit();
      }}
    >
      <InlineRenameInput
        aria-label={inputAriaLabel ?? t("common.rename")}
        className={inputClassName}
        maxLength={maxLength}
        onBlur={() => {
          // The group commits when focus leaves its action buttons too.
        }}
        onCancel={onCancel}
        onCommit={onCommit}
        onValueChange={onChange}
        value={value}
      />
      {suffix}
      {action}
    </span>
  );
};
