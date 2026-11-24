import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CheckIcon, ExternalLinkIcon, LockIcon } from "@stll/ui/icons";

import { focusBrowserExtensionTab } from "@/features/chat/browser-control/browser-extension-bridge";
import { usePendingBrowserSignIn } from "@/features/chat/browser-control/browser-sign-in-handoff";

/**
 * Docked card shown above the chat composer when a background browser tab
 * requires the member to sign in. The tab stays in the background until the
 * member explicitly clicks "Open sign-in tab", and never touches passwords.
 */
export const BrowserSignInCard = () => {
  const pending = usePendingBrowserSignIn();
  const t = useTranslations();

  if (pending === null) {
    return null;
  }

  return (
    <div
      className="bg-card border-border mb-2 flex flex-col gap-2 rounded-lg border px-3.5 py-2.5 shadow-xs"
      data-slot="browser-sign-in-card"
      role="status"
    >
      <div className="flex items-start gap-2.5">
        <span className="bg-muted text-foreground mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md">
          <LockIcon className="size-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-foreground text-xs font-medium">
            {pending.host === null
              ? t("chat.browserSignIn.title")
              : t("chat.browserSignIn.titleWithHost", { host: pending.host })}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("chat.browserSignIn.description")}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            focusBrowserExtensionTab();
          }}
          size="xs"
        >
          <ExternalLinkIcon className="size-3" />
          {t("chat.browserSignIn.openTab")}
        </Button>
        <Button onClick={pending.resume} size="xs" variant="outline">
          <CheckIcon className="size-3" />
          {t("chat.browserSignIn.continue")}
        </Button>
        <Button onClick={pending.cancel} size="xs" variant="ghost">
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
};
