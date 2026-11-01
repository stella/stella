import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BROWSER_EXTENSION_STATUS } from "@stll/api-contract/browser-control";
import { ChatLink } from "@stll/chat/link";
import { Button } from "@stll/ui/button";
import { BrowserControlIcon } from "@stll/ui/icons";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/popover";

import { useBrowserExtensionState } from "@/features/chat/browser-control/browser-extension-bridge";
import { useBrowserExtensionStoreUrl } from "@/features/chat/browser-control/use-browser-extension-store-url";

/**
 * The extension's state as one quiet icon in the composer status row, like
 * the globe and shield beside it: a dot marks a connected extension, and
 * otherwise the icon opens the steps to install or connect it.
 */
export const BrowserExtensionChip = () => {
  const { status } = useBrowserExtensionState();
  const storeUrl = useBrowserExtensionStoreUrl();
  const t = useTranslations();

  switch (status) {
    case BROWSER_EXTENSION_STATUS.checking:
    case BROWSER_EXTENSION_STATUS.unsupportedBrowser:
    case BROWSER_EXTENSION_STATUS.unsupportedDevice:
      return null;
    case BROWSER_EXTENSION_STATUS.connected:
      return (
        <Button
          aria-label={t("chat.browserExtension.connected")}
          className="relative"
          size="icon-xs"
          tooltip={t("chat.browserExtension.description")}
          variant="muted"
        >
          <BrowserControlIcon className="size-3.5" />
          <span
            aria-hidden="true"
            className="bg-success ring-background absolute end-0.5 bottom-0.5 size-1.5 rounded-full ring-1"
          />
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
  const label = needsInstall
    ? t("chat.browserExtension.install")
    : t("chat.browserExtension.connect");
  return (
    <Popover key={status}>
      <PopoverTrigger
        render={
          <Button
            aria-label={label}
            size="icon-xs"
            tooltip={label}
            variant="muted"
          />
        }
      >
        <BrowserControlIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup align="start" side="top">
        <div className="flex max-w-64 flex-col items-start gap-2">
          <PopoverDescription>
            {needsInstall
              ? t("chat.browserExtension.installDescription")
              : t("chat.browserExtension.connectDescription")}
          </PopoverDescription>
          {needsInstall && storeUrl !== null && (
            <ChatLink appearance="tray" href={storeUrl}>
              {t("chat.browserExtension.install")}
            </ChatLink>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
};
