/**
 * List formatting buttons: bullet, numbered, indent, outdent.
 */

import {
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  ListIcon,
  ListOrderedIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "../../lib/utils";

export type ListType = "bullet" | "numbered" | "none";

export type ListState = {
  type: ListType;
  level: number;
  isInList: boolean;
  numId?: number;
};

export type ListButtonsProps = {
  listState?: ListState;
  onBulletList?: () => void;
  onNumberedList?: () => void;
  onIndent?: () => void;
  onOutdent?: () => void;
  disabled?: boolean;
  showIndentButtons?: boolean;
  compact?: boolean;
  hasIndent?: boolean;
};

export const createDefaultListState = (): ListState => ({
  type: "none",
  level: 0,
  isInList: false,
});

const ICON_SIZE = 20;

const btnCls = (active: boolean, disabled: boolean, compact: boolean) =>
  cn(
    "flex items-center justify-center rounded transition-colors",
    compact ? "size-7" : "size-8",
    active
      ? "bg-[var(--doc-primary-light)] text-[var(--doc-primary)]"
      : "text-[var(--doc-text-muted)] hover:bg-[var(--doc-bg-hover)]",
    disabled &&
      "cursor-not-allowed text-[var(--doc-text-subtle)] opacity-[0.16] disabled:hover:bg-transparent disabled:hover:text-[var(--doc-text-subtle)]",
  );

export function ListButtons({
  listState,
  onBulletList,
  onNumberedList,
  onIndent,
  onOutdent,
  disabled = false,
  showIndentButtons = true,
  compact = false,
  hasIndent = false,
}: ListButtonsProps) {
  const t = useTranslations("folio");
  const isBullet = listState?.type === "bullet";
  const isNumbered = listState?.type === "numbered";
  const isInList = listState?.isInList || isBullet || isNumbered;
  const canOutdent = (isInList && (listState?.level ?? 0) > 0) || hasIndent;

  return (
    <div
      className="inline-flex items-center gap-1"
      role="group"
      aria-label={t("listFormatting")}
    >
      <button
        aria-label={t("bulletList")}
        aria-pressed={isBullet}
        className={btnCls(isBullet, disabled, compact)}
        disabled={disabled}
        onClick={onBulletList}
        onMouseDown={(e) => e.preventDefault()}
        title={t("bulletList")}
        type="button"
      >
        <ListIcon size={ICON_SIZE} />
      </button>
      <button
        aria-label={t("numberedList")}
        aria-pressed={isNumbered}
        className={btnCls(isNumbered, disabled, compact)}
        disabled={disabled}
        onClick={onNumberedList}
        onMouseDown={(e) => e.preventDefault()}
        title={t("numberedList")}
        type="button"
      >
        <ListOrderedIcon size={ICON_SIZE} />
      </button>
      {showIndentButtons && (
        <>
          <span
            className="mx-1.5 h-5 w-px bg-[var(--doc-border)]"
            role="separator"
          />
          <button
            aria-label={t("decreaseIndent")}
            className={btnCls(false, disabled || !canOutdent, compact)}
            disabled={disabled || !canOutdent}
            onClick={onOutdent}
            onMouseDown={(e) => e.preventDefault()}
            title={t("decreaseIndent")}
            type="button"
          >
            <IndentDecreaseIcon size={ICON_SIZE} />
          </button>
          <button
            aria-label={t("increaseIndent")}
            className={btnCls(false, disabled, compact)}
            disabled={disabled}
            onClick={onIndent}
            onMouseDown={(e) => e.preventDefault()}
            title={t("increaseIndent")}
            type="button"
          >
            <IndentIncreaseIcon size={ICON_SIZE} />
          </button>
        </>
      )}
    </div>
  );
}
