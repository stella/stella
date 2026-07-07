import type * as React from "react";

import { MonitorIcon, PlugIcon, TerminalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button, buttonVariants } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { CopyField } from "@/components/copy-field";
import { env } from "@/env";
import type { TranslationKey } from "@/i18n/types";
import {
  detectDesktopPlatform,
  MACOS_DMG_URL,
  WINDOWS_EXE_URL,
  WINDOWS_MSI_URL,
} from "@/lib/desktop-downloads";

/**
 * Single source of truth for the card order: drives the rendered card
 * list, the footer button's next-card lookup, and the last-card check,
 * so reordering cards can never desync the walkthrough flow.
 */
const DOWNLOAD_TARGETS = ["desktop", "assistant", "terminal"] as const;

export type DownloadTarget = (typeof DOWNLOAD_TARGETS)[number];

type DownloadStepProps = {
  onNext: () => void;
  onSkip: () => void;
  /** Which setup target is shown in the right-hand preview panel. */
  selected: DownloadTarget;
  onSelect: (target: DownloadTarget) => void;
};

export const DownloadStep = ({
  onNext,
  onSkip,
  selected,
  onSelect,
}: DownloadStepProps) => {
  const t = useTranslations();
  // Footer walkthrough: while a next card exists the primary button
  // advances the selection; on the last card it starts the setup.
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
        {DOWNLOAD_TARGETS.map((target) => {
          const meta = TARGET_CARD_META[target];
          return (
            <TargetCard
              description={t(meta.descriptionKey)}
              icon={meta.icon}
              key={target}
              onSelect={() => onSelect(target)}
              selected={selected === target}
              title={t(meta.titleKey)}
            />
          );
        })}
      </div>

      {/* Below md the wizard hides the whole preview column, which is the
          only other place the download buttons and copy commands render;
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
 * Right-panel setup instructions for the selected target on the
 * onboarding download step, following the wizard's per-step preview
 * mechanism (globe for jurisdictions, stack for the catalogue).
 */
export const DownloadSetupPreview = ({ target }: DownloadSetupPreviewProps) => {
  if (target === "desktop") {
    return <DesktopSetupPanel />;
  }
  if (target === "terminal") {
    return <TerminalSetupPanel />;
  }
  return <AssistantSetupPanel />;
};

type TargetCardMeta = {
  icon: typeof MonitorIcon;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
};

const TARGET_CARD_META = {
  desktop: {
    icon: MonitorIcon,
    titleKey: "settings.account.desktop",
    descriptionKey: "settings.account.desktopAppDescription",
  },
  assistant: {
    icon: PlugIcon,
    titleKey: "onboarding.mcpCardTitle",
    descriptionKey: "onboarding.mcpCardDescription",
  },
  terminal: {
    icon: TerminalIcon,
    titleKey: "onboarding.cliCardTitle",
    descriptionKey: "onboarding.cliCardDescription",
  },
} as const satisfies Record<DownloadTarget, TargetCardMeta>;

type TargetCardProps = {
  title: string;
  description: string;
  icon: typeof MonitorIcon;
  selected: boolean;
  onSelect: () => void;
};

const TargetCard = ({
  title,
  description,
  icon: Icon,
  selected,
  onSelect,
}: TargetCardProps) => (
  <button
    aria-pressed={selected}
    onClick={onSelect}
    type="button"
    className={cn(
      "rounded-lg border p-4 text-start transition-colors",
      selected
        ? "border-foreground bg-accent/60 ring-foreground/20 ring-1"
        : "border-border hover:bg-muted/40",
    )}
  >
    <div className="flex items-start gap-3">
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <h2 className="text-foreground text-sm font-medium">{title}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      </div>
    </div>
  </button>
);

// Mirrors `MCP_HTTP_PATH` in `apps/api/src/mcp/constants.ts`. Not
// imported directly: that module pulls in the server-only `@/api/env`,
// which is unsafe to bundle into the browser build.
const MCP_HTTP_PATH = "/mcp";

const CLI_INSTALL_COMMAND = "npm i -g @stll/cli";

const apiOrigin = () => env.VITE_API_URL.replace(/\/$/u, "");

const SetupPanel = ({
  title,
  children,
}: React.PropsWithChildren<{ title: string }>) => (
  <div className="bg-background border-border/40 flex max-h-full w-full max-w-[400px] flex-col gap-4 overflow-y-auto rounded-2xl border p-6 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.06)]">
    <h3 className="text-foreground text-sm font-medium">{title}</h3>
    {children}
  </div>
);

const AssistantGuide = ({
  name,
  steps,
}: {
  name: string;
  steps: readonly string[];
}) => (
  <section className="flex flex-col gap-1.5">
    <h4 className="text-foreground text-xs font-medium">{name}</h4>
    <ol className="text-muted-foreground list-decimal space-y-1 ps-4 text-sm">
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  </section>
);

const AssistantSetupPanel = () => {
  const t = useTranslations();
  const serverUrl = `${apiOrigin()}${MCP_HTTP_PATH}`;

  return (
    <SetupPanel title={t("onboarding.mcpCardTitle")}>
      <CopyField
        label={t("onboarding.setupServerAddressLabel")}
        value={serverUrl}
      />
      <AssistantGuide
        name="Claude"
        steps={[
          t("onboarding.setupClaudeStep1"),
          t("onboarding.setupPasteAddressStep"),
          t("onboarding.setupClaudeStep3"),
        ]}
      />
      <AssistantGuide
        name="ChatGPT"
        steps={[
          t("onboarding.setupChatgptStep1"),
          t("onboarding.setupPasteAddressStep"),
        ]}
      />
    </SetupPanel>
  );
};

const DesktopSetupPanel = () => {
  const t = useTranslations();
  const platform = detectDesktopPlatform();

  const primaryClass = cn(buttonVariants(), "w-full");
  const secondaryClass =
    "text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline self-center";

  let downloads: React.ReactNode = (
    <>
      <a className={primaryClass} href={WINDOWS_EXE_URL}>
        {t("settings.account.desktopDownloadWindows")}
      </a>
      <a
        className={cn(buttonVariants({ variant: "outline" }), "w-full")}
        href={MACOS_DMG_URL}
      >
        {t("settings.account.desktopDownloadMac")}
      </a>
    </>
  );
  if (platform === "mac") {
    downloads = (
      <>
        <a className={primaryClass} href={MACOS_DMG_URL}>
          {t("settings.account.desktopDownloadMac")}
        </a>
        <a className={secondaryClass} href={WINDOWS_EXE_URL}>
          {t("settings.account.desktopDownloadOtherMac")}
        </a>
      </>
    );
  } else if (platform === "windows") {
    downloads = (
      <>
        <a className={primaryClass} href={WINDOWS_EXE_URL}>
          {t("settings.account.desktopDownloadWindows")}
        </a>
        <a className={secondaryClass} href={WINDOWS_MSI_URL}>
          {t("settings.account.desktopDownloadOtherWindows")}
        </a>
      </>
    );
  }

  return (
    <SetupPanel title={t("settings.account.desktop")}>
      <div className="flex flex-col gap-2">{downloads}</div>
    </SetupPanel>
  );
};

const TerminalSetupPanel = () => {
  const t = useTranslations();
  const loginCommand = `stella auth login --server ${apiOrigin()}`;

  return (
    <SetupPanel title={t("onboarding.cliCardTitle")}>
      <p className="text-muted-foreground text-sm">
        {t("onboarding.setupTerminalHint")}
      </p>
      <CopyField
        label={t("settings.connections.cliInstallLabel")}
        value={CLI_INSTALL_COMMAND}
      />
      <CopyField
        label={t("settings.connections.cliLoginLabel")}
        value={loginCommand}
      />
    </SetupPanel>
  );
};
