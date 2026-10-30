import type { ComponentProps } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ShieldCheckIcon, ShieldIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

/**
 * The remaining `Button` props pass through, so an overlay can render the
 * toggle as its trigger and hand it the events and ARIA it needs.
 */
type ChatAnonymizedToggleProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "onChange" | "size" | "variant"
> & {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  size?: "icon-sm" | "icon-xs" | undefined;
};

export const ChatAnonymizedToggle = ({
  disabled = false,
  enabled,
  onChange,
  size = "icon-sm",
  tooltip,
  ...props
}: ChatAnonymizedToggleProps) => {
  const t = useTranslations();
  const Icon = enabled ? ShieldCheckIcon : ShieldIcon;

  return (
    <Button
      {...props}
      aria-label={t("chat.anonymizedMode")}
      aria-pressed={enabled}
      // Quiet status-row control: muted at rest, borderless, only the
      // usual ghost hover surface. The enabled state speaks through
      // the info-tinted icon, not a filled chip.
      className="text-muted-foreground hover:text-foreground"
      data-pressed={enabled ? "" : undefined}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      size={size}
      tooltip={
        tooltip ??
        t(
          enabled
            ? "chat.anonymizedModeEnabled"
            : "chat.anonymizedModeDisabled",
        )
      }
      variant={enabled ? "secondary" : "ghost"}
    >
      <Icon
        className={cn(
          size === "icon-xs" ? "size-3.5" : "size-4",
          enabled && "text-info",
        )}
      />
    </Button>
  );
};
