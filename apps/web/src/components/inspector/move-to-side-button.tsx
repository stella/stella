import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { PanelRightIcon } from "@stll/ui/icons";

import Tooltip from "@/components/tooltip";

/**
 * The one header control that moves the main view into the side panel. The
 * panel glyph says where the view goes (the inspector at the inline end), and
 * mirrors under RTL where the panel sits at the other edge. `swaps` names the
 * case where the side panel already holds a view that comes back to the main
 * area in exchange.
 */
export const MoveToSideButton = ({
  className,
  onClick,
  swaps = false,
}: {
  className?: string | undefined;
  onClick: () => void;
  swaps?: boolean;
}) => {
  const t = useTranslations();
  const label = swaps ? t("inspector.swapViews") : t("inspector.moveToSide");
  return (
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          className={className}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
        >
          <DirectionalIcon className="size-4" icon={PanelRightIcon} />
        </Button>
      }
    />
  );
};
