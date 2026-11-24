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

/** A neutral host for the signed-in site the preview reads. */
const PREVIEW_HOST = "portal.example.com";

type BrowserExtensionPreviewCardProps = {
  /** One line on the plugin's state, shown under the preview. */
  description: string;
  /** The composer control the card explains on hover and focus. */
  trigger: ReactElement;
};

/**
 * Hover and focus preview of the Chrome plugin: you ask, stella reads the
 * page you are signed in to and finds the passage, then answers citing it.
 * Built like the anonymization preview beside it.
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
  // Explicit ReactNode: the inferred `t.rich` result carries React 19's
  // Promise<AwaitedReactNode> member, which promise-function-async flags.
  const page = (found: boolean): ReactNode =>
    t.rich("chat.browserExtensionPreview.page", {
      passage: (chunks) => <Passage found={found}>{chunks}</Passage>,
    });
  const answer: ReactNode = t.rich("chat.browserExtensionPreview.answer", {
    cite: (chunks) => (
      <span
        className="bg-info/12 text-info rounded-sm px-0.5"
        data-browser-extension-preview="citation"
      >
        {chunks}
      </span>
    ),
  });

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
              <span className="text-muted-foreground mb-1.5 flex items-center gap-1.5 border-b pb-1.5">
                <GlobeIcon className="size-3 shrink-0" />
                <bdi>{PREVIEW_HOST}</bdi>
              </span>
              {/* The page loads, then the passage that answers lights up. */}
              <AnimatedPreview
                pace="beat"
                stages={[
                  { id: "page", content: page(false) },
                  { id: "passage", content: page(true) },
                ]}
              />
            </PreviewStep>
          ),
        },
        {
          id: "answered",
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
                  { id: "answer", content: answer },
                ]}
              />
            </PreviewStep>
          ),
        },
      ]}
    />
  );
};

type PassageProps = {
  found: boolean;
  children: ReactNode;
};

const Passage = ({ found, children }: PassageProps) => (
  <span
    className={cn("rounded-sm px-0.5", found && "bg-warning/15")}
    data-browser-extension-preview={found ? "passage" : undefined}
  >
    {children}
  </span>
);

type PreviewStepProps = {
  caption: string;
  icon: LucideIcon;
  tone: "user" | "assistant";
  children: ReactNode;
};

const PreviewStep = ({
  caption,
  icon: StepIcon,
  tone,
  children,
}: PreviewStepProps) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-muted-foreground text-2xs flex items-center gap-1.5 font-medium">
      <StepIcon className="size-3 shrink-0" />
      {caption}
    </span>
    <div
      className={cn(
        "rounded-md border px-2 py-1.5 text-xs leading-relaxed",
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
