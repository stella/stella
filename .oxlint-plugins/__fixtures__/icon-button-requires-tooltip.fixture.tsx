import { SettingsIcon, XIcon } from "lucide-react";

import { Button } from "@stll/ui/components/button";
import { MenuTrigger } from "@stll/ui/components/menu";
import {
  Tooltip as TooltipRoot,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/components/tooltip";

import Tooltip from "@/components/tooltip";

const t = (key: string) => key;

export const Fixture = () => (
  <div>
    <Tooltip content={t("settings")} render={<Button size="icon" />}>
      <SettingsIcon />
    </Tooltip>

    <TooltipRoot>
      <TooltipTrigger render={<Button size="icon-xs" />}>
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup>{t("close")}</TooltipPopup>
    </TooltipRoot>

    <Button size="sm">
      <SettingsIcon />
      {t("settings")}
    </Button>

    <Button size="icon" tooltip={t("settings")}>
      <SettingsIcon />
    </Button>

    <Tooltip
      content={t("more")}
      render={<MenuTrigger render={<Button size="icon-xs" />} />}
    >
      <SettingsIcon />
    </Tooltip>

    {/* oxlint-disable-next-line icon-button-requires-tooltip/icon-button-requires-tooltip -- fixture: unlabeled icon-only Button must be reported */}
    <Button size="icon">
      <SettingsIcon />
    </Button>

    {/* oxlint-disable-next-line icon-button-requires-tooltip/icon-button-requires-tooltip -- fixture: native icon-only button without tooltip must be reported */}
    <button aria-label={t("close")} type="button">
      <XIcon />
    </button>

    {/* oxlint-disable-next-line icon-button-requires-tooltip/icon-button-requires-tooltip -- fixture: trigger rendered as an icon Button without tooltip must be reported */}
    <MenuTrigger render={<Button size="icon-xs" />}>
      <SettingsIcon />
    </MenuTrigger>
  </div>
);
