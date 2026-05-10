import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

type InlineEditProps = {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  /** Extra content after the input (e.g. file extension). */
  suffix?: React.ReactNode;
  className?: string;
  inputClassName?: string;
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
  className,
  inputClassName,
}: InlineEditProps) => {
  const t = useTranslations();

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <input
        autoFocus
        className={cn(
          "border-input bg-background text-foreground h-6 min-w-0 rounded-sm border px-1.5 text-xs leading-none transition-[box-shadow,border-color] duration-150 outline-none",
          "focus:border-ring focus:ring-ring/16 focus:ring-2 focus:ring-offset-0",
          inputClassName,
        )}
        onBlur={onCommit}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            onCancel();
          }
        }}
        value={value}
      />
      {suffix}
      <Button
        className="h-6 shrink-0 gap-0.5 px-2 text-xs"
        onMouseDown={(e) => {
          e.preventDefault();
          onCommit();
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
