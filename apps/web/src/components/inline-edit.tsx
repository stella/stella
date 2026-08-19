import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { contentDir } from "@stll/ui/use-content-dir";
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
  className?: string | undefined;
  inputClassName?: string | undefined;
};

/**
 * Compact inline rename used in toolbars / tab headers.
 *
 * Deliberately NOT built on the `<Input>` primitive: that's tuned
 * for full-form inputs (rounded-lg, shadow, larger text) and looked
 * oversized when dropped inline next to a label. This stays as a
 * raw `<input>` with text-xs to match the surrounding label height
 * exactly — only a subtle border + soft 2px focus ring at 16%
 * opacity signals the edit affordance, no dark "primary" ring leak.
 */
export const InlineEdit = ({
  value,
  onChange,
  onCommit,
  onCancel,
  suffix,
  action,
  className,
  inputClassName,
}: InlineEditProps) => {
  const t = useTranslations();

  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
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
      <input
        autoFocus
        className={cn(
          "border-input bg-background text-foreground h-6 min-w-0 rounded-sm border px-1.5 text-xs leading-none transition-[box-shadow,border-color] duration-150 outline-none",
          "focus:border-ring focus:ring-ring/16 focus:ring-2 focus:ring-offset-0",
          inputClassName,
        )}
        dir={contentDir(value)}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          }
          if (e.key === "Escape") {
            onCancel();
          }
        }}
        value={value}
      />
      {suffix}
      {action}
      <Button
        className="h-6 shrink-0 gap-0.5 px-2 text-xs"
        onClick={onCommit}
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        size="xs"
        type="button"
        variant="default"
      >
        {t("common.done")}
        <kbd className="text-[10px] opacity-70">{t("common.enterKey")}</kbd>
      </Button>
    </span>
  );
};
