import type { ReactElement, ReactNode } from "react";

import { useTranslations } from "use-intl";

import {
  AnimatedPreview,
  AnimatedPreviewCard,
} from "@stll/ui/animated-preview";
import type { LucideIcon } from "@stll/ui/icons";
import {
  BrowserControlIcon,
  GlobeIcon,
  MessageSquareIcon,
  UserIcon,
} from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

const PREVIEW_HOST = "portal.example.com";

type BrowserExtensionPreviewCardProps = {
  /** One-line status summary shown under the preview and announced to screen readers. */
  description: string;
  /** The composer trigger the card explains on hover and focus. */
  trigger: ReactElement;
};

/**
 * Hover and focus preview of the Chrome plugin chip, matching the
 * anonymization shield beside it.
 */
export const BrowserExtensionPreviewCard = ({
  description,
  trigger,
}: BrowserExtensionPreviewCardProps) => (
  <AnimatedPreviewCard description={description} trigger={trigger}>
    <BrowserExtensionPreview />
  </AnimatedPreviewCard>
);

/** Looping 3-stage preview shared by the hover card and the click popover. */
export const BrowserExtensionPreview = () => {
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
          id: "read",
          content: (
            <PreviewStep
              caption={t("chat.browserExtensionPreview.steps.read")}
              icon={BrowserControlIcon}
              tone="assistant"
            >
              <div className="flex flex-col gap-1.5">
                <span className="text-muted-foreground text-2xs inline-flex items-center gap-1">
                  <GlobeIcon className="size-3 shrink-0" />
                  <span>{PREVIEW_HOST}</span>
                </span>
                <AnimatedPreview
                  pace="beat"
                  stages={[
                    { id: "loading", content: <TypingDots /> },
                    {
                      id: "excerpt",
                      content: (
                        <span>{t("chat.browserExtensionPreview.excerpt")}</span>
                      ),
                    },
                  ]}
                />
              </div>
            </PreviewStep>
          ),
        },
        {
          id: "cited",
          content: (
            <PreviewStep
              caption={t("chat.browserExtensionPreview.steps.cited")}
              icon={MessageSquareIcon}
              tone="assistant"
            >
              <AnimatedPreview
                pace="beat"
                stages={[
                  { id: "typing", content: <TypingDots /> },
                  {
                    id: "answer",
                    content: (
                      <span>{t("chat.browserExtensionPreview.answer")}</span>
                    ),
                  },
                ]}
              />
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

const TypingDots = () => (
  <span className="inline-flex items-center gap-1 py-1">
    <span className="bg-foreground-placeholder size-1 rounded-full" />
    <span className="bg-foreground-placeholder size-1 rounded-full" />
    <span className="bg-foreground-placeholder size-1 rounded-full" />
  </span>
);
