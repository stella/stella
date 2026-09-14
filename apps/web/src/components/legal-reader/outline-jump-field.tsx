import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/input";

import { clampSelectedIndex } from "@/components/legal-reader/outline-jump-field.logic";

type OutlineJumpFieldProps = {
  /** How many entries the query matched; the selection moves within them. */
  matchCount: number;
  /** Submitted: go to the selected match. */
  onJump: () => void;
  onSelectedIndexChange: (index: number) => void;
  onValueChange: (value: string) => void;
  /** Which ranked match the selection is on. */
  selectedIndex: number;
  /** The selected entry as one line, for readers who cannot see the rail. */
  selectedText: string | undefined;
  value: string;
};

/**
 * The rail's address bar: it ranks the outline against what the reader typed,
 * putting the provision they named (`§ 10`, or `10`) first and selected, the
 * provisions it only begins or appears in under it. Enter goes to the
 * selection; the arrow keys move it down the list.
 *
 * A form rather than a keydown handler for Enter, so submission is the one
 * the browser already knows how to perform and the field reads as one control
 * to assistive tech.
 */
export const OutlineJumpField = ({
  matchCount,
  onJump,
  onSelectedIndexChange,
  onValueChange,
  selectedIndex,
  selectedText,
  value,
}: OutlineJumpFieldProps) => {
  const t = useTranslations();

  const moveSelection = (step: number) => {
    onSelectedIndexChange(
      clampSelectedIndex({ count: matchCount, index: selectedIndex + step }),
    );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onJump();
      }}
      role="search"
    >
      <Input
        aria-label={t("statutes.outlineJumpLabel")}
        className="h-7 text-xs"
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveSelection(1);
            return;
          }

          if (event.key === "ArrowUp") {
            event.preventDefault();
            moveSelection(-1);
          }
        }}
        placeholder={t("statutes.outlineJumpPlaceholder")}
        type="search"
        value={value}
      />
      {value.trim().length > 0 && matchCount === 0 && (
        <p className="text-muted-foreground px-1 pt-1.5 text-xs">
          {t("common.noResults")}
        </p>
      )}
      {/* The selection is a highlighted row in the panel, which says nothing
          to a screen reader as the arrow keys move it. */}
      <span aria-live="polite" className="sr-only">
        {selectedText ?? ""}
      </span>
    </form>
  );
};
