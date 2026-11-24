import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  BROWSER_EXTENSION_STATUS,
  type BrowserExtensionStatus,
} from "@stll/api-contract/browser-control";
import { ChatLink } from "@stll/chat/link";
import { Badge } from "@stll/ui/badge";
import { Button, buttonVariants } from "@stll/ui/button";
import {
  BrowserControlIcon,
  GlobeIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
} from "@stll/ui/icons";
import {
  Popover,
  PopoverDescription,
  PopoverPanel,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";
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

/** The labels, status badge, preview caption, and copy for each visible extension state. */
const metaFor = (status: VisibleStatus) => {
  switch (status) {
    case BROWSER_EXTENSION_STATUS.connected:
      return {
        badge: "common.connected",
        description: "chat.browserExtension.connectedDescription",
        label: "chat.browserExtension.connected",
        previewDescription: "chat.browserExtensionPreview.connected",
        tone: "success",
      } as const;
    case BROWSER_EXTENSION_STATUS.extensionOutdated:
      return {
        badge: "chat.browserExtension.statusUpdating",
        description: "chat.browserExtension.updatingDescription",
        label: "chat.browserExtension.updating",
        previewDescription: "chat.browserExtensionPreview.updating",
        tone: "warning",
      } as const;
    case BROWSER_EXTENSION_STATUS.stellaOutdated:
      return {
        badge: "chat.browserExtension.statusReload",
        description: "chat.browserExtension.reloadDescription",
        label: "chat.browserExtension.reload",
        previewDescription: "chat.browserExtensionPreview.reload",
        tone: "warning",
      } as const;
    case BROWSER_EXTENSION_STATUS.notInstalled:
      return {
        badge: "chat.browserExtension.statusNotInstalled",
        description: "chat.browserExtension.installDescription",
        label: "chat.browserExtension.install",
        previewDescription: "chat.browserExtensionPreview.notInstalled",
        tone: "neutral",
      } as const;
    case BROWSER_EXTENSION_STATUS.needsSiteAccess:
    case BROWSER_EXTENSION_STATUS.notPaired:
      return {
        badge: "common.notConnected",
        description: "chat.browserExtension.connectDescription",
        label: "chat.browserExtension.connect",
        previewDescription: "chat.browserExtensionPreview.notConnected",
        tone: "warning",
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
 * Pure presentation of the browser extension composer chip: one quiet icon in
 * the composer status row, with an animated hover preview matching the
 * anonymization shield beside it and a structured popover on click across
 * every state (including connected).
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
  const needsConnect =
    status === BROWSER_EXTENSION_STATUS.notPaired ||
    status === BROWSER_EXTENSION_STATUS.needsSiteAccess;
  const needsReload = status === BROWSER_EXTENSION_STATUS.stellaOutdated;
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
      <PopoverPanel align="start" className="w-80" padding="default" side="top">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="bg-muted text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md">
              <BrowserControlIcon className="size-4" />
            </span>
            <PopoverTitle>
              {t("settings.connections.browserExtensionTitle")}
            </PopoverTitle>
          </div>
          <Badge dot size="xs" tone={meta.tone}>
            {t(meta.badge)}
          </Badge>
        </div>

        <PopoverDescription>{t(meta.description)}</PopoverDescription>

        {isConnected && (
          <ul className="bg-muted/50 flex flex-col gap-2 rounded-md px-3 py-2.5 text-xs">
            <li className="flex items-start gap-2">
              <GlobeIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <span>{t("chat.browserExtension.tipAsk")}</span>
            </li>
            <li className="flex items-start gap-2">
              <BrowserControlIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <span>{t("chat.browserExtension.tipShareTab")}</span>
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheckIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <span>{t("chat.browserExtension.tipControl")}</span>
            </li>
          </ul>
        )}

        {needsInstall && (
          <ul className="bg-muted/50 flex flex-col gap-2 rounded-md px-3 py-2.5 text-xs">
            <li className="flex items-start gap-2">
              <GlobeIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <span>{t("chat.browserExtension.benefitSessions")}</span>
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheckIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <span>{t("chat.browserExtension.benefitApproval")}</span>
            </li>
            <li className="flex items-start gap-2">
              <BrowserControlIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <span>{t("chat.browserExtension.benefitShareTab")}</span>
            </li>
          </ul>
        )}

        {needsConnect && (
          <ol className="bg-muted/50 flex flex-col gap-2 rounded-md px-3 py-2.5 text-xs">
            <li className="flex items-start gap-2">
              <span className="bg-background text-muted-foreground text-3xs mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border font-semibold">
                1
              </span>
              <span>{t("chat.browserExtension.connectStep1")}</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="bg-background text-muted-foreground text-3xs mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border font-semibold">
                2
              </span>
              <span>{t("chat.browserExtension.connectStep2")}</span>
            </li>
          </ol>
        )}

        {isConnected && (
          <div className="border-border flex items-center justify-between border-t pt-2.5">
            <a
              className={cn(
                buttonVariants({ size: "xs", variant: "ghost" }),
                "text-muted-foreground hover:text-foreground -ms-1.5",
              )}
              href="/settings/account/connections"
            >
              <SlidersHorizontalIcon className="size-3.5" />
              {t("chat.browserExtension.manageSites")}
            </a>
          </div>
        )}

        {needsInstall && (
          <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-2.5">
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
          <div className="border-border flex items-center border-t pt-2.5">
            <Button onClick={reloadPage} size="sm">
              <RefreshCwIcon className="size-3.5" />
              {t("chat.browserExtension.reload")}
            </Button>
          </div>
        )}
      </PopoverPanel>
    </Popover>
  );
};

/**
 * The extension's state as one quiet icon in the composer status row, like
 * the globe and shield beside it: a dot marks a connected extension, and
 * clicking opens status, guidance, and setup actions.
 */
export const BrowserExtensionChip = () => {
  const { status } = useBrowserExtensionState();
  const storeUrl = useBrowserExtensionStoreUrl();
  return <BrowserExtensionChipView status={status} storeUrl={storeUrl} />;
};
