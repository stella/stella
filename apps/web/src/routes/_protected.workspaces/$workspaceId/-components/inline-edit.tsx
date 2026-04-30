import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";
import { useTranslations } from "use-intl";

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
          "bg-background h-6 rounded border px-1.5 text-sm",
          "focus:ring-primary outline-none focus:ring-1",
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
