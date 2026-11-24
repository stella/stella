import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  BROWSER_EXTENSION_STATUS,
  type BrowserExtensionStatus,
} from "@stll/api-contract/browser-control";
import { ChatLink } from "@stll/chat/link";
import { Button, buttonVariants } from "@stll/ui/button";
import { BrowserControlIcon, RefreshCwIcon } from "@stll/ui/icons";
import {
  Popover,
  PopoverDescription,
  PopoverPanel,
  PopoverTrigger,
} from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import {
  BrowserExtensionPreview,
  BrowserExtensionPreviewCard,
} from "@/components/chat/browser-extension-preview";
import { useBrowserExtensionState } from "@/features/chat/browser-control/browser-extension-bridge";
import { useBrowserExtensionStoreUrl } from "@/features/chat/browser-control/use-browser-extension-store-url";

type VisibleStatus =
  | typeof BROWSER_EXTENSION_STATUS.connected
  | typeof BROWSER_EXTENSION_STATUS.extensionOutdated
  | typeof BROWSER_EXTENSION_STATUS.stellaOutdated
  | typeof BROWSER_EXTENSION_STATUS.needsSiteAccess
  | typeof BROWSER_EXTENSION_STATUS.notPaired
  | typeof BROWSER_EXTENSION_STATUS.notInstalled;

/** The accessible label, hover caption, and short popover line for each visible state. */
const metaFor = (status: VisibleStatus) => {
  switch (status) {
    case BROWSER_EXTENSION_STATUS.connected:
      return {
        description: "chat.browserExtension.connectedDescription",
        label: "chat.browserExtension.connected",
        previewDescription: "chat.browserExtensionPreview.connected",
        statusLabel: "common.connected",
      } as const;
    case BROWSER_EXTENSION_STATUS.extensionOutdated:
      return {
        description: "chat.browserExtension.updatingDescription",
        label: "chat.browserExtension.updating",
        previewDescription: "chat.browserExtensionPreview.updating",
        statusLabel: "chat.browserExtension.statusUpdating",
      } as const;
    case BROWSER_EXTENSION_STATUS.stellaOutdated:
      return {
        description: "chat.browserExtension.reloadDescription",
        label: "chat.browserExtension.reload",
        previewDescription: "chat.browserExtensionPreview.reload",
        statusLabel: "chat.browserExtension.statusReload",
      } as const;
    case BROWSER_EXTENSION_STATUS.notInstalled:
      return {
        description: "chat.browserExtension.installDescription",
        label: "chat.browserExtension.install",
        previewDescription: "chat.browserExtensionPreview.notInstalled",
        statusLabel: "chat.browserExtension.statusNotInstalled",
      } as const;
    case BROWSER_EXTENSION_STATUS.needsSiteAccess:
    case BROWSER_EXTENSION_STATUS.notPaired:
      return {
        description: "chat.browserExtension.connectDescription",
        label: "chat.browserExtension.connect",
        previewDescription: "chat.browserExtensionPreview.notConnected",
        statusLabel: "common.notConnected",
      } as const;
    default:
      status satisfies never;
      return panic("Unhandled browser extension status");
  }
};

const reloadPage = () => {
  window.location.reload();
};

export type BrowserExtensionChipViewProps = {
  status: BrowserExtensionStatus;
  storeUrl: string | null;
  /** Initial popover state; only used by visual previews. */
  defaultOpen?: boolean;
};

/**
 * Pure presentation of the Chrome plugin composer chip: one quiet icon in the
 * composer status row, with an animated preview on hover and a compact,
 * animated popover on click.
 */
export const BrowserExtensionChipView = ({
  status,
  storeUrl,
  defaultOpen = false,
}: BrowserExtensionChipViewProps) => {
  const t = useTranslations();

  switch (status) {
    case BROWSER_EXTENSION_STATUS.checking:
    case BROWSER_EXTENSION_STATUS.unsupportedBrowser:
    case BROWSER_EXTENSION_STATUS.unsupportedDevice:
      return null;
    case BROWSER_EXTENSION_STATUS.connected:
    case BROWSER_EXTENSION_STATUS.extensionOutdated:
    case BROWSER_EXTENSION_STATUS.stellaOutdated:
    case BROWSER_EXTENSION_STATUS.needsSiteAccess:
    case BROWSER_EXTENSION_STATUS.notPaired:
    case BROWSER_EXTENSION_STATUS.notInstalled:
      break;
    default:
      status satisfies never;
      return panic("Unhandled browser extension status");
  }

  const isConnected = status === BROWSER_EXTENSION_STATUS.connected;
  const needsInstall = status === BROWSER_EXTENSION_STATUS.notInstalled;
  const needsReload = status === BROWSER_EXTENSION_STATUS.stellaOutdated;
  const showPreview =
    isConnected ||
    needsInstall ||
    status === BROWSER_EXTENSION_STATUS.notPaired ||
    status === BROWSER_EXTENSION_STATUS.needsSiteAccess;
  const meta = metaFor(status);
  const label = t(meta.label);

  return (
    <Popover defaultOpen={defaultOpen} key={status}>
      <BrowserExtensionPreviewCard
        description={t(meta.previewDescription)}
        trigger={
          <PopoverTrigger
            render={
              <Button
                aria-label={label}
                className="relative"
                size="icon-xs"
                tooltip={false}
                variant="muted"
              />
            }
          >
            <BrowserControlIcon className="size-3.5" />
            {isConnected && (
              <span
                aria-hidden="true"
                className="bg-success ring-background absolute end-0.5 bottom-0.5 size-1.5 rounded-full ring-1"
              />
            )}
          </PopoverTrigger>
        }
      />
      <PopoverPanel align="start" className="w-72" padding="md" side="top">
        {showPreview && <BrowserExtensionPreview />}

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-foreground font-medium">
              {t("chat.browserExtension.name")}
            </span>
            <span className="text-muted-foreground">{t(meta.statusLabel)}</span>
          </div>

          <PopoverDescription>{t(meta.description)}</PopoverDescription>

          {isConnected && (
            <a
              className={cn(
                buttonVariants({ size: "xs", variant: "ghost" }),
                "text-muted-foreground hover:text-foreground -ms-1.5 w-fit",
              )}
              href="/settings/account/connections"
            >
              {t("chat.browserExtension.manageSites")}
            </a>
          )}

          {needsInstall && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {storeUrl !== null && (
                <ChatLink appearance="tray" href={storeUrl}>
                  {t("chat.browserExtension.install")}
                </ChatLink>
              )}
              <Button onClick={reloadPage} size="xs" variant="ghost">
                <RefreshCwIcon className="size-3" />
                {t("chat.browserExtension.alreadyInstalledReload")}
              </Button>
            </div>
          )}

          {needsReload && (
            <Button className="w-fit" onClick={reloadPage} size="xs">
              <RefreshCwIcon className="size-3" />
              {t("chat.browserExtension.reload")}
            </Button>
          )}
        </div>
      </PopoverPanel>
    </Popover>
  );
};

/**
 * The Chrome plugin's state as one quiet icon in the composer status row,
 * like the globe and shield beside it.
 */
export const BrowserExtensionChip = () => {
  const { status } = useBrowserExtensionState();
  const storeUrl = useBrowserExtensionStoreUrl();
  return <BrowserExtensionChipView status={status} storeUrl={storeUrl} />;
};
