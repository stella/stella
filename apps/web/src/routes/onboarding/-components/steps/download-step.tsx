import type * as React from "react";

import { panic } from "better-result";
import { ExternalLinkIcon, MonitorIcon, TerminalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { MCP_HTTP_PATH } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import { AIProviderIcon } from "@/components/ai-provider-icons";
import { CopyField } from "@/components/copy-field";
import { DesktopDownloadButtons } from "@/components/desktop-download-buttons";
import { env } from "@/env";
import { DesktopConnectionStatus } from "@/features/desktop/desktop-connection-status";
import { useDesktopAccountConnection } from "@/features/desktop/use-desktop-account-connection";
import { useHydrationSafeDesktopPlatform } from "@/hooks/use-hydration-safe-desktop-platform";
import { externalApiOrigin } from "@/lib/api-origins";
import { detached } from "@/lib/detached";
import { sanitizeHref } from "@/lib/sanitize-href";
import { ClipboardWorkflowPreview } from "@/routes/onboarding/-components/clipboard-workflow-preview";

const ASSISTANT_DOCS_URL =
  "https://stll.app/docs/get-started/connect-ai-assistant/";
const CLI_DOCS_URL = "https://stll.app/docs/get-started/cli/";

/**
 * Single source of truth for the card order: drives the rendered card
 * list, the footer button's next-card lookup, and the last-card check,
 * so reordering cards can never desync the walkthrough flow.
 */
const DOWNLOAD_TARGETS = ["desktop", "assistant"] as const;

export type DownloadTarget = (typeof DOWNLOAD_TARGETS)[number];

type DownloadStepProps = {
  onNext: () => void;
  onSkip: () => void;
  /** Which target is highlighted and shown in the right-hand preview panel. */
  selected: DownloadTarget;
  onSelect: (target: DownloadTarget) => void;
};

/**
 * Last wizard step. The desktop app is the one thing set up here; the
 * assistant card only announces the plugin and hands the walkthrough to
 * the docs.
 */
export const DownloadStep = ({
  onNext,
  onSkip,
  selected,
  onSelect,
}: DownloadStepProps) => {
  const t = useTranslations();
  // Footer walkthrough: while a next card exists the primary button
  // advances the highlight; on the last card it lands the user in the app.
  const nextTarget = DOWNLOAD_TARGETS.at(
    DOWNLOAD_TARGETS.indexOf(selected) + 1,
  );

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.appsTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.appsSubtitle")}
      </p>

      <div className="mt-8 flex flex-col gap-3">
        <TargetCard
          description={t("settings.account.desktopAppDescription")}
          icon={<MonitorIcon className="text-muted-foreground size-4" />}
          onSelect={() => onSelect("desktop")}
          selected={selected === "desktop"}
          title={t("settings.account.desktop")}
        />
        <TargetCard
          description={t("onboarding.mcpCardDescription")}
          icon={<AssistantIconPair />}
          onSelect={() => onSelect("assistant")}
          selected={selected === "assistant"}
          title={t("onboarding.mcpCardTitle")}
        />
      </div>

      {/* Below md the wizard hides the whole preview column, which is the
          only other place the download buttons and docs links render;
          without this inline fallback the step would be action-less on
          phones. */}
      <div className="mt-4 md:hidden">
        <DownloadSetupPreview target={selected} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 pt-8">
        <Button onClick={onSkip} type="button" variant="ghost">
          {t("onboarding.skipStep")}
        </Button>
        <Button
          type="button"
          onClick={() => {
            if (nextTarget) {
              onSelect(nextTarget);
              return;
            }
            onNext();
          }}
        >
          {nextTarget ? t("common.next") : t("onboarding.getStarted")}
        </Button>
      </div>
    </>
  );
};

type DownloadSetupPreviewProps = {
  target: DownloadTarget;
};

/**
 * Right-panel content for the highlighted target, following the wizard's
 * per-step preview mechanism (globe for jurisdictions, stack for the
 * catalogue).
 */
export const DownloadSetupPreview = ({ target }: DownloadSetupPreviewProps) => {
  switch (target) {
    case "desktop":
      return <DesktopSetupPanel />;
    case "assistant":
      return <AssistantPanel />;
    default:
      target satisfies never;
      return panic(`Unknown download target: ${String(target)}`);
  }
};

type TargetCardProps = {
  title: string;
  description: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
};

const TargetCard = ({
  title,
  description,
  icon,
  selected,
  onSelect,
}: TargetCardProps) => (
  <button
    aria-pressed={selected}
    onClick={onSelect}
    type="button"
    className={cn(
      "rounded-lg border p-4 text-start",
      selected
        ? "border-foreground bg-accent/60 ring-foreground/20 ring-1"
        : "border-border hover:bg-muted/40",
    )}
  >
    <div className="flex items-start gap-3">
      {/* Fixed to the widest icon (the assistant pair) so titles align. */}
      <span className="mt-0.5 flex w-7 shrink-0 items-center">{icon}</span>
      <div className="min-w-0 flex-1">
        <h2 className="text-foreground text-sm font-medium">{title}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      </div>
    </div>
  </button>
);

/** Compact Claude and ChatGPT marks for the assistant card's icon slot. */
const AssistantIconPair = () => (
  <span className="flex items-center -space-x-1">
    <AIProviderIcon className="size-4" provider="anthropic" />
    <AIProviderIcon className="size-4" provider="openai" />
  </span>
);

const SetupPanel = ({
  title,
  children,
}: React.PropsWithChildren<{ title: string }>) => (
  <div className="bg-background border-border/40 shadow-floating flex max-h-full w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-2xl border p-6">
    <h3 className="text-foreground text-sm font-medium">{title}</h3>
    {children}
  </div>
);

/** Brand tile that opens the setup guide for that assistant. */
const AssistantTile = ({
  name,
  children,
}: React.PropsWithChildren<{ name: string }>) => (
  <a
    className="bg-muted/60 text-foreground hover:bg-muted flex flex-1 items-center justify-center gap-2.5 rounded-xl px-4 py-3 text-sm font-medium"
    href={sanitizeHref(ASSISTANT_DOCS_URL)}
    rel="noreferrer"
    target="_blank"
  >
    {children}
    {name}
  </a>
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
      "inline-flex min-h-11 items-center gap-1.5 text-sm underline-offset-4 hover:underline",
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

const AssistantPanel = () => {
  const t = useTranslations();

  return (
    <SetupPanel title={t("onboarding.mcpCardTitle")}>
      <div className="flex gap-3">
        <AssistantTile name="Claude">
          <AIProviderIcon className="size-6" provider="anthropic" />
        </AssistantTile>
        <AssistantTile name="ChatGPT">
          <AIProviderIcon className="size-6" provider="openai" />
        </AssistantTile>
      </div>
      <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
        {t("onboarding.mcpCardDescription")}
      </p>
      {/* The guide names the hosted server; a self-hosted deployment has to
          hand its own address over here or the reader connects to the wrong
          stella. */}
      {env.VITE_SELFHOST && (
        <CopyField
          label={t("settings.connections.mcpUrlLabel")}
          value={`${externalApiOrigin().replace(/\/$/u, "")}${MCP_HTTP_PATH}`}
        />
      )}
      <DocsLink href={ASSISTANT_DOCS_URL}>
        {t("onboarding.assistantDocsLink")}
      </DocsLink>
      <DocsLink
        className="text-muted-foreground text-xs"
        href={CLI_DOCS_URL}
        icon={TerminalIcon}
      >
        {t("onboarding.cliDocsLink")}
      </DocsLink>
    </SetupPanel>
  );
};

const DesktopSetupPanel = () => {
  const t = useTranslations();
  const platform = useHydrationSafeDesktopPlatform();
  // Downloading here starts the watch, so launching the app is the whole
  // setup: no trip back to settings to connect.
  const { connect, startWatch, state } = useDesktopAccountConnection();
  const shortcut = platform === "mac" ? "⌘ ⇧ V" : "Ctrl + Shift + V";
  const copyShortcut = platform === "mac" ? "⌘ C" : "Ctrl + C";

  return (
    <SetupPanel title={t("settings.account.desktop")}>
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
    </SetupPanel>
  );
};
