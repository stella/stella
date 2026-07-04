import { CpuIcon, PaperclipIcon, PlusIcon, ServerIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { cn } from "@stll/ui/lib/utils";

type ComposerPlusMenuProps = {
  disabled: boolean;
  onOpenFilePicker: () => void;
  onOpenModelSelector?: (() => void) | undefined;
  onOpenMcpServers?: (() => void) | undefined;
  /** Positioning for the trigger button, differing per slot: absolute on the
   *  empty placeholder line, `me-auto` at the start of the bottom action row. */
  triggerClassName?: string | undefined;
};

// The composer's (+) affordance: a single Menu rendered into whichever slot the
// composer state calls for. A circular, filled button (not a bare ghost icon)
// carrying the attach / models / MCP actions. Shared by every chat surface (main
// chat, inspector side chat, file-chat overlay) so the affordance can never
// drift; Models and MCP items appear only when the surface passes a callback.
export const ComposerPlusMenu = ({
  disabled,
  onOpenFilePicker,
  onOpenModelSelector,
  onOpenMcpServers,
  triggerClassName,
}: ComposerPlusMenuProps) => {
  const t = useTranslations();

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("chat.composerMenu.open")}
        disabled={disabled}
        render={
          <Button
            className={cn(
              "border-border size-7 shrink-0 rounded-full border",
              triggerClassName,
            )}
            size="icon-xs"
            type="button"
            variant="secondary"
          />
        }
      >
        <PlusIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <MenuItem onClick={onOpenFilePicker}>
          <PaperclipIcon />
          {t("chat.attachFile")}
        </MenuItem>
        {onOpenModelSelector && (
          <MenuItem onClick={onOpenModelSelector}>
            <CpuIcon />
            {t("chat.composerMenu.models")}
          </MenuItem>
        )}
        {onOpenMcpServers && (
          <MenuItem onClick={onOpenMcpServers}>
            <ServerIcon />
            {t("chat.composerMenu.mcpServers")}
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
};
