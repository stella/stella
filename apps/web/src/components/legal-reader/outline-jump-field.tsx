import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/components/input";

type OutlineJumpFieldProps = {
  /** Submitted: the reader asked to go to whatever the field addresses. */
  onJump: () => void;
  onValueChange: (value: string) => void;
  value: string;
};

/**
 * The rail's address bar: a designation (`§ 10`, `čl. 10`) goes to that
 * provision, anything else narrows the outline to the entries stating it.
 *
 * A form rather than a keydown handler, so Enter submits the way the browser
 * already knows how to and the field reads as one control to assistive tech.
 */
export const OutlineJumpField = ({
  onJump,
  onValueChange,
  value,
}: OutlineJumpFieldProps) => {
  const t = useTranslations();

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
        placeholder={t("statutes.outlineJumpPlaceholder")}
        type="search"
        value={value}
      />
    </form>
  );
};
