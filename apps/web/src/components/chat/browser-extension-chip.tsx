import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  BROWSER_EXTENSION_STATUS,
  type BrowserExtensionStatus,
} from "@stll/api-contract/browser-control";
import { ChatLink } from "@stll/chat/link";
import { Button, buttonVariants } from "@stll/ui/button";
import { BrowserControlIcon } from "@stll/ui/icons";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { BrowserExtensionPreviewCard } from "@/components/chat/browser-extension-preview";
import { useBrowserExtensionState } from "@/features/chat/browser-control/browser-extension-bridge";
import { useBrowserExtensionStoreUrl } from "@/features/chat/browser-control/use-browser-extension-store-url";

type VisibleStatus =
  | typeof BROWSER_EXTENSION_STATUS.connected
  | typeof BROWSER_EXTENSION_STATUS.extensionOutdated
  | typeof BROWSER_EXTENSION_STATUS.stellaOutdated
  | typeof BROWSER_EXTENSION_STATUS.needsSiteAccess
  | typeof BROWSER_EXTENSION_STATUS.notPaired
  | typeof BROWSER_EXTENSION_STATUS.notInstalled;

/**
 * Per visible state: the control's accessible label, the line under the
 * hover preview, and the popover's status word and sentence.
 */
const copyFor = (status: VisibleStatus) => {
  switch (status) {
    case BROWSER_EXTENSION_STATUS.connected:
      return {
        label: "chat.browserExtension.connected",
        preview: "chat.browserExtensionPreview.connected",
        status: "common.connected",
        description: "chat.browserExtension.connectedDescription",
      } as const;
    case BROWSER_EXTENSION_STATUS.extensionOutdated:
      return {
        label: "chat.browserExtension.updating",
        preview: "chat.browserExtensionPreview.updating",
        status: "chat.browserExtension.statusUpdating",
        description: "chat.browserExtension.updatingDescription",
      } as const;
    case BROWSER_EXTENSION_STATUS.stellaOutdated:
      return {
        label: "chat.browserExtension.reload",
        preview: "chat.browserExtensionPreview.reload",
        status: "chat.browserExtension.statusReload",
        description: "chat.browserExtension.reloadDescription",
      } as const;
    case BROWSER_EXTENSION_STATUS.notInstalled:
      return {
        label: "chat.browserExtension.install",
        preview: "chat.browserExtensionPreview.notInstalled",
        status: "chat.browserExtension.statusNotInstalled",
        description: "chat.browserExtension.installDescription",
      } as const;
    case BROWSER_EXTENSION_STATUS.needsSiteAccess:
      return {
        label: "chat.browserExtension.connect",
        preview: "chat.browserExtensionPreview.notConnected",
        status: "common.notConnected",
        description: "chat.browserExtension.siteAccessDescription",
      } as const;
    case BROWSER_EXTENSION_STATUS.notPaired:
      return {
        label: "chat.browserExtension.connect",
        preview: "chat.browserExtensionPreview.notConnected",
        status: "common.notConnected",
        description: "chat.browserExtension.connectDescription",
      } as const;
    default:
      status satisfies never;
      return panic("Unhandled browser extension status");
  }
};

const reloadPage = () => {
  window.location.reload();
};

type BrowserExtensionActionProps = {
  status: VisibleStatus;
  storeUrl: string | null;
};

/** The popover's one thing to do for a state, if it has one. */
const BrowserExtensionAction = ({
  status,
  storeUrl,
}: BrowserExtensionActionProps) => {
  const t = useTranslations();

  switch (status) {
    case BROWSER_EXTENSION_STATUS.connected:
      return (
        <a
          className={cn(
            buttonVariants({ size: "xs", variant: "outline" }),
            "w-fit",
          )}
          href="/settings/account/connections"
        >
          {t("chat.browserExtension.manageSites")}
        </a>
      );
    case BROWSER_EXTENSION_STATUS.notInstalled:
      return (
        <div className="flex items-center gap-1">
          {storeUrl !== null && (
            <ChatLink appearance="tray" href={storeUrl}>
              {t("common.addToChrome")}
            </ChatLink>
          )}
          <Button onClick={reloadPage} size="xs" variant="ghost">
            {t("chat.browserExtension.alreadyInstalledReload")}
          </Button>
        </div>
      );
    case BROWSER_EXTENSION_STATUS.stellaOutdated:
      return (
        <Button className="w-fit" onClick={reloadPage} size="xs">
          {t("chat.browserExtension.reload")}
        </Button>
      );
    case BROWSER_EXTENSION_STATUS.extensionOutdated:
    case BROWSER_EXTENSION_STATUS.needsSiteAccess:
    case BROWSER_EXTENSION_STATUS.notPaired:
      return null;
    default:
      status satisfies never;
      return panic("Unhandled browser extension status");
  }
};

export type BrowserExtensionChipViewProps = {
  status: BrowserExtensionStatus;
  storeUrl: string | null;
  /** Initial popover state; only used by visual previews. */
  defaultOpen?: boolean;
};

/**
 * Pure presentation of the Chrome plugin control in the composer status row:
 * one quiet icon, tinted like the anonymization shield beside it while the
 * plugin is connected. Hover plays what the plugin does; a click opens its
 * state and the one thing to do about it.
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

  const connected = status === BROWSER_EXTENSION_STATUS.connected;
  const copy = copyFor(status);

  return (
    <Popover defaultOpen={defaultOpen} key={status}>
      <BrowserExtensionPreviewCard
        description={t(copy.preview)}
        trigger={
          <PopoverTrigger
            render={
              <Button
                aria-label={t(copy.label)}
                size="icon-xs"
                tooltip={false}
                variant={connected ? "secondary" : "muted"}
              />
            }
          >
            <BrowserControlIcon
              className={cn("size-3.5", connected && "text-info")}
            />
          </PopoverTrigger>
        }
      />
      <PopoverPanel align="start" className="w-72" padding="md" side="top">
        <div className="flex flex-col gap-1 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-foreground font-medium">
              {t("chat.browserExtension.name")}
            </span>
            <span className="text-muted-foreground">{t(copy.status)}</span>
          </div>
          <p className="text-muted-foreground leading-relaxed">
            {t(copy.description)}
          </p>
        </div>
        <BrowserExtensionAction status={status} storeUrl={storeUrl} />
      </PopoverPanel>
    </Popover>
  );
};

/** The Chrome plugin's live state as one quiet icon in the composer status row. */
export const BrowserExtensionChip = () => {
  const { status } = useBrowserExtensionState();
  const storeUrl = useBrowserExtensionStoreUrl();
  return <BrowserExtensionChipView status={status} storeUrl={storeUrl} />;
};
