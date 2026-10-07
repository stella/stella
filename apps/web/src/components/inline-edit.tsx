import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
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
   * Action button(s) between the input and Done (e.g. a suggest wand).
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
  className?: string | undefined;
  inputClassName?: string | undefined;
};

export const InlineEdit = ({
  value,
  onChange,
  onCommit,
  onCancel,
  suffix,
  action,
  inputAriaLabel,
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
      <Button
        className="h-lh shrink-0 gap-0.5 px-2"
        onClick={onCommit}
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        size="xs"
        type="button"
        variant="default"
      >
        {t("common.done")}
        <kbd className="text-3xs opacity-70">{t("common.enterKey")}</kbd>
      </Button>
    </span>
  );
};
