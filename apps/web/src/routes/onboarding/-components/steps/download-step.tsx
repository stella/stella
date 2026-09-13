import type * as React from "react";

import { ExternalLinkIcon, MonitorIcon, TerminalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import { AIProviderIcon } from "@/components/ai-provider-icons";
import { DesktopDownloadButtons } from "@/components/desktop-download-buttons";
import { DesktopConnectionStatus } from "@/features/desktop/desktop-connection-status";
import { useDesktopAccountConnection } from "@/features/desktop/use-desktop-account-connection";
import { useHydrationSafeDesktopPlatform } from "@/hooks/use-hydration-safe-desktop-platform";
import { detached } from "@/lib/detached";
import { sanitizeHref } from "@/lib/sanitize-href";
import { ClipboardWorkflowPreview } from "@/routes/onboarding/-components/clipboard-workflow-preview";

const ASSISTANT_DOCS_URL =
  "https://stll.app/docs/get-started/connect-ai-assistant/";
const CLI_DOCS_URL = "https://stll.app/docs/get-started/cli/";

type DownloadStepProps = {
  onNext: () => void;
  onSkip: () => void;
};

/**
 * Last wizard step. The desktop app is the one thing worth setting up
 * here, so it gets the download panel; assistants and the CLI are only
 * announced, with the walkthrough left to the docs.
 */
export const DownloadStep = ({ onNext, onSkip }: DownloadStepProps) => {
  const t = useTranslations();

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.appsTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.appsSubtitle")}
      </p>

      <div className="mt-8 flex flex-col gap-3">
        <InfoCard>
          <div className="flex items-start gap-3">
            <MonitorIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 className="text-foreground text-sm font-medium">
                {t("settings.account.desktop")}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {t("settings.account.desktopAppDescription")}
              </p>
            </div>
          </div>
        </InfoCard>

        <InfoCard>
          <div className="flex items-center gap-2">
            <AssistantBadge name="Claude">
              <AIProviderIcon className="size-5" provider="anthropic" />
            </AssistantBadge>
            <AssistantBadge name="ChatGPT">
              <AIProviderIcon className="size-5" provider="openai" />
            </AssistantBadge>
          </div>
          <h2 className="text-foreground mt-4 text-sm font-medium">
            {t("onboarding.mcpCardTitle")}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm text-pretty">
            {t("onboarding.mcpCardDescription")}
          </p>
          <DocsLink className="mt-3" href={ASSISTANT_DOCS_URL}>
            {t("onboarding.assistantDocsLink")}
          </DocsLink>
        </InfoCard>
      </div>

      <DocsLink
        className="text-muted-foreground mt-4 text-xs"
        href={CLI_DOCS_URL}
        icon={TerminalIcon}
      >
        {t("onboarding.cliDocsLink")}
      </DocsLink>

      {/* Below md the wizard hides the whole preview column, which is the
          only other place the download buttons render; without this inline
          fallback the step would be action-less on phones. */}
      <div className="mt-4 md:hidden">
        <DesktopSetupPanel />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 pt-8">
        <Button onClick={onSkip} type="button" variant="ghost">
          {t("onboarding.skipStep")}
        </Button>
        <Button onClick={onNext} type="button">
          {t("onboarding.getStarted")}
        </Button>
      </div>
    </>
  );
};

const InfoCard = ({ children }: React.PropsWithChildren) => (
  <div className="border-border rounded-lg border p-4">{children}</div>
);

const AssistantBadge = ({
  name,
  children,
}: React.PropsWithChildren<{ name: string }>) => (
  <span className="bg-muted/60 text-foreground inline-flex items-center gap-2 rounded-full py-1.5 ps-2 pe-3 text-sm font-medium">
    {children}
    {name}
  </span>
);

type DocsLinkProps = React.PropsWithChildren<{
  href: string;
  className?: string;
  icon?: typeof ExternalLinkIcon;
}>;

const DocsLink = ({
  href,
  className,
  icon: Icon = ExternalLinkIcon,
  children,
}: DocsLinkProps) => (
  <a
    className={cn(
      "inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline",
      className,
    )}
    href={sanitizeHref(href)}
    rel="noreferrer"
    target="_blank"
  >
    <Icon className="size-3.5 shrink-0" />
    {children}
  </a>
);

/**
 * Right-panel desktop setup for the download step, following the wizard's
 * per-step preview mechanism (globe for jurisdictions, stack for the
 * catalogue).
 */
export const DesktopSetupPanel = () => {
  const t = useTranslations();
  const platform = useHydrationSafeDesktopPlatform();
  // Downloading here starts the watch, so launching the app is the whole
  // setup: no trip back to settings to connect.
  const { connect, startWatch, state } = useDesktopAccountConnection();
  const shortcut = platform === "mac" ? "⌘ ⇧ V" : "Ctrl + Shift + V";
  const copyShortcut = platform === "mac" ? "⌘ C" : "Ctrl + C";

  return (
    <div className="bg-background border-border/40 flex max-h-full w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-2xl border p-6 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.06)]">
      <h3 className="text-foreground text-sm font-medium">
        {t("settings.account.desktop")}
      </h3>
      <ClipboardWorkflowPreview
        copyShortcut={copyShortcut}
        shortcut={shortcut}
        title={t("settings.account.desktopClipboardTitle")}
      />
      <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
        {t("settings.account.desktopClipboardDescription")}{" "}
        <kbd
          className="bg-muted text-foreground rounded-md px-1.5 py-0.5 font-mono text-xs"
          dir="ltr"
        >
          {shortcut}
        </kbd>
      </p>
      <DesktopDownloadButtons onDownload={startWatch} platform={platform} />
      <DesktopConnectionStatus
        onRetry={() => {
          detached(connect(), "onboarding-download-step.connect-desktop");
        }}
        state={state}
      />
    </div>
  );
};
