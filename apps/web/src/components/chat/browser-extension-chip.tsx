import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BROWSER_EXTENSION_STATUS } from "@stll/api-contract/browser-control";
import { ChatLink } from "@stll/chat/link";
import { Button } from "@stll/ui/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/popover";

import { useBrowserExtensionState } from "@/features/chat/browser-control/browser-extension-bridge";

type BrowserExtensionChipProps = {
  installUrl?: string;
};

export const BrowserExtensionChip = ({
  installUrl,
}: BrowserExtensionChipProps) => {
  const { status } = useBrowserExtensionState();
  const t = useTranslations();

  switch (status) {
    case BROWSER_EXTENSION_STATUS.checking:
    case BROWSER_EXTENSION_STATUS.unsupportedBrowser:
      return null;
    case BROWSER_EXTENSION_STATUS.connected:
      return (
        <Button
          size="xs"
          tooltip={t("chat.browserExtension.description")}
          variant="muted"
        >
          <span
            aria-hidden="true"
            className="bg-success size-1.5 shrink-0 rounded-full"
          />
          <span>{t("chat.browserExtension.connected")}</span>
        </Button>
      );
    case BROWSER_EXTENSION_STATUS.needsSiteAccess:
    case BROWSER_EXTENSION_STATUS.notPaired:
    case BROWSER_EXTENSION_STATUS.notInstalled:
      break;
    default:
      status satisfies never;
      return panic("Unhandled browser extension status");
  }

  const needsInstall = status === BROWSER_EXTENSION_STATUS.notInstalled;
  return (
    <Popover key={status}>
      <PopoverTrigger render={<Button size="xs" variant="muted" />}>
        {needsInstall
          ? t("chat.browserExtension.install")
          : t("chat.browserExtension.connect")}
      </PopoverTrigger>
      <PopoverPopup align="start" side="top">
        <div className="flex max-w-64 flex-col items-start gap-2">
          <PopoverDescription>
            {needsInstall
              ? t("chat.browserExtension.installDescription")
              : t("chat.browserExtension.connectDescription")}
          </PopoverDescription>
          {needsInstall && installUrl && (
            <ChatLink appearance="tray" href={installUrl}>
              {t("chat.browserExtension.install")}
            </ChatLink>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
};
