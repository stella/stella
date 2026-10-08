import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { BookTextIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import type { useReaderProvisionMode } from "@/hooks/use-reader-provision-mode";

/** The toolbar size of each reader that carries the toggle. */
const TOGGLE_SIZE = {
  page: { button: "icon-sm", icon: "size-4" },
  pane: { button: "icon-xs", icon: "size-3.5" },
} as const;

/** Shows or hides the cited provisions under every paragraph of a decision. */
export const ReaderProvisionModeToggle = ({
  mode,
  size,
}: {
  mode: ReturnType<typeof useReaderProvisionMode>;
  size: keyof typeof TOGGLE_SIZE;
}) => {
  const t = useTranslations();
  return (
    <Button
      aria-label={t("caseLaw.reader.expandProvisions")}
      aria-pressed={mode.expandProvisions}
      data-pressed={mode.expandProvisions ? "" : undefined}
      onClick={mode.toggle}
      size={TOGGLE_SIZE[size].button}
      tooltip={t("caseLaw.reader.expandProvisions")}
      variant="ghost"
    >
      <BookTextIcon aria-hidden="true" className={cn(TOGGLE_SIZE[size].icon)} />
    </Button>
  );
};
