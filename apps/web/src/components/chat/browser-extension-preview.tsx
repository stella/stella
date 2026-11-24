import type { ReactElement, ReactNode } from "react";

import { useTranslations } from "use-intl";

import {
  AnimatedPreview,
  AnimatedPreviewCard,
} from "@stll/ui/animated-preview";
import type { LucideIcon } from "@stll/ui/icons";
import {
  BrowserControlIcon,
  CheckIcon,
  GlobeIcon,
  ShieldCheckIcon,
  UserIcon,
} from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

const PREVIEW_SITE_HOST = "portal.example.com";
const PREVIEW_SOURCE_CHIP = "portal.example.com · § 2001";

type BrowserExtensionPreviewCardProps = {
  /** One-line status & action summary shown under the preview and announced to screen readers. */
  description: string;
  /** The composer trigger the card explains on hover and focus. */
  trigger: ReactElement;
};

/**
 * Hover and focus preview of the browser extension chip, matching the
 * anonymization shield beside it: ask in chat, approve in Chrome using your
 * own signed-in session, and get a cited answer back.
 */
export const BrowserExtensionPreviewCard = ({
  description,
  trigger,
}: BrowserExtensionPreviewCardProps) => (
  <AnimatedPreviewCard description={description} trigger={trigger}>
    <BrowserExtensionPreview />
  </AnimatedPreviewCard>
);

const BrowserExtensionPreview = () => {
  const t = useTranslations();

  return (
    <AnimatedPreview
      pace="read"
      playback="loop"
      stages={[
        {
          id: "ask",
          content: (
            <PreviewStep
              caption={t("chat.browserExtensionPreview.steps.ask")}
              icon={UserIcon}
              tone="user"
            >
              {t("chat.browserExtensionPreview.prompt")}
            </PreviewStep>
          ),
        },
        {
          id: "approve",
          content: (
            <PreviewStep
              caption={t("chat.browserExtensionPreview.steps.approve")}
              icon={ShieldCheckIcon}
              tone="assistant"
            >
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1 font-medium">
                    <GlobeIcon className="text-muted-foreground size-3 shrink-0" />
                    <span>{PREVIEW_SITE_HOST}</span>
                  </span>
                  <AnimatedPreview
                    inline
                    pace="beat"
                    stages={[
                      {
                        id: "pending",
                        content: (
                          <span className="bg-primary text-primary-foreground text-3xs inline-flex items-center rounded-sm px-1.5 py-0.5 leading-none font-medium">
                            {t("consent.allow")}
                          </span>
                        ),
                      },
                      {
                        id: "approved",
                        content: (
                          <span className="bg-success/15 text-success text-3xs inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 leading-none font-medium">
                            <CheckIcon className="size-2.5" />
                            {t("chat.browserExtensionPreview.allowed")}
                          </span>
                        ),
                      },
                    ]}
                  />
                </div>
                <span className="text-muted-foreground text-2xs">
                  {t("chat.browserExtensionPreview.sessionNote")}
                </span>
              </div>
            </PreviewStep>
          ),
        },
        {
          id: "cited",
          content: (
            <PreviewStep
              caption={t("chat.browserExtensionPreview.steps.cited")}
              icon={BrowserControlIcon}
              tone="assistant"
            >
              <div className="flex flex-col gap-1.5">
                <span>{t("chat.browserExtensionPreview.answer")}</span>
                <span className="bg-muted text-muted-foreground text-3xs inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 leading-none font-medium">
                  <GlobeIcon className="size-2.5 shrink-0" />
                  {PREVIEW_SOURCE_CHIP}
                </span>
              </div>
            </PreviewStep>
          ),
        },
      ]}
    />
  );
};

type PreviewStepProps = {
  icon: LucideIcon;
  caption: string;
  tone: "user" | "assistant";
  children: ReactNode;
};

const PreviewStep = ({
  icon: Icon,
  caption,
  tone,
  children,
}: PreviewStepProps) => (
  <div className="flex flex-col gap-1.5">
    <div className="text-muted-foreground text-2xs flex items-center gap-1.5 font-medium">
      <Icon className="size-3 shrink-0" />
      <span>{caption}</span>
    </div>
    <div
      className={cn(
        "border-border/70 text-foreground rounded-md border px-2.5 py-2 text-xs leading-relaxed",
        tone === "user" ? "bg-muted/60" : "bg-card",
      )}
    >
      {children}
    </div>
  </div>
);
