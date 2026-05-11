import { ShieldCheckIcon, ShieldIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";

type ChatAnonymizedToggleProps = {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  size?: "icon-sm" | "icon-xs" | undefined;
};

export const ChatAnonymizedToggle = ({
  enabled,
  onChange,
  size = "icon-sm",
}: ChatAnonymizedToggleProps) => {
  const t = useTranslations();
  const Icon = enabled ? ShieldCheckIcon : ShieldIcon;

  return (
    <Tooltip
      content={t(
        enabled ? "chat.anonymizedModeEnabled" : "chat.anonymizedModeDisabled",
      )}
      render={
        <Button
          aria-label={t("chat.anonymizedMode")}
          aria-pressed={enabled}
          data-pressed={enabled ? "" : undefined}
          onClick={() => onChange(!enabled)}
          size={size}
          variant={enabled ? "secondary" : "ghost"}
        >
          <Icon
            className={cn(
              size === "icon-xs" ? "size-3.5" : "size-4",
              enabled && "text-success",
            )}
          />
        </Button>
      }
    />
  );
};
