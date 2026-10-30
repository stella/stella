import type { ReactElement, ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  AnimatedPreview,
  AnimatedPreviewCard,
} from "@stll/ui/animated-preview";
import type { LucideIcon } from "@stll/ui/icons";
import { EyeIcon, MessageSquareIcon, SendIcon, UserIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

type AnonymizationPreviewCardProps = {
  enabled: boolean;
  /** The anonymization toggle the card explains. */
  trigger: ReactElement;
};

/**
 * Hover and focus preview of the anonymization toggle: what you write, what
 * the AI receives, what it answers and what you read, with a line saying
 * whether the toggle is on right now.
 */
export const AnonymizationPreviewCard = ({
  enabled,
  trigger,
}: AnonymizationPreviewCardProps) => {
  const t = useTranslations();

  return (
    <AnimatedPreviewCard
      description={t(
        enabled
          ? "chat.anonymizationPreview.on"
          : "chat.anonymizationPreview.off",
      )}
      trigger={trigger}
    >
      <AnonymizationPreview />
    </AnimatedPreviewCard>
  );
};

export const AnonymizationPreview = () => {
  const t = useTranslations();
  const prompt = (rendering: PersonalDataRendering) =>
    t.rich("chat.anonymizationPreview.prompt", {
      address: personalData("address", rendering),
      nationalId: personalData("nationalId", rendering),
      person1: personalData("person1", rendering),
      person2: personalData("person2", rendering),
    });
  const answer = (rendering: PersonalDataRendering) =>
    t.rich("chat.anonymizationPreview.answer", {
      person1: personalData("person1", rendering),
      person2: personalData("person2", rendering),
    });

  return (
    <AnimatedPreview
      pace="read"
      playback="loop"
      stages={[
        {
          id: "written",
          content: (
            <PreviewStep
              caption={t("chat.anonymizationPreview.steps.written")}
              icon={UserIcon}
              tone="user"
            >
              {prompt("found")}
            </PreviewStep>
          ),
        },
        {
          id: "sent",
          content: (
            <PreviewStep
              caption={t("chat.anonymizationPreview.steps.sent")}
              icon={SendIcon}
              tone="user"
            >
              {prompt("masking")}
            </PreviewStep>
          ),
        },
        {
          id: "answered",
          content: (
            <PreviewStep
              caption={t("chat.anonymizationPreview.steps.answered")}
              icon={MessageSquareIcon}
              tone="assistant"
            >
              {/* The answer arrives: a moment of typing, then the text. */}
              <AnimatedPreview
                pace="beat"
                stages={[
                  { id: "typing", content: <TypingDots /> },
                  { id: "answer", content: answer("masked") },
                ]}
              />
            </PreviewStep>
          ),
        },
        {
          id: "restored",
          content: (
            <PreviewStep
              caption={t("chat.anonymizationPreview.steps.restored")}
              icon={EyeIcon}
              tone="assistant"
            >
              {answer("restoring")}
            </PreviewStep>
          ),
        },
      ]}
    />
  );
};

/**
 * Wire-format placeholders the model sees in place of each kind of personal
 * data. They are what the model reads, so they stay untranslated.
 */
const PLACEHOLDERS = {
  person1: "[PERSON_1]",
  person2: "[PERSON_2]",
  nationalId: "[NATIONAL_ID_1]",
  address: "[ADDRESS_1]",
} as const;

type PersonalDataTag = keyof typeof PLACEHOLDERS;

/** The order the personal data turns into placeholders, one step apart. */
const MASKING_ORDER = {
  person1: 0,
  nationalId: 1,
  address: 2,
  person2: 3,
} as const satisfies Record<PersonalDataTag, number>;

/**
 * `found`: highlighted where it was written. `masking`: turning into its
 * placeholder. `masked`: the placeholder alone. `restoring`: the placeholder
 * turning back into the real value.
 */
type PersonalDataRendering = "found" | "masking" | "masked" | "restoring";

const personalData =
  (tag: PersonalDataTag, rendering: PersonalDataRendering) =>
  (chunks: ReactNode) => (
    <PersonalData rendering={rendering} tag={tag} value={chunks} />
  );

type PersonalDataProps = {
  tag: PersonalDataTag;
  value: ReactNode;
  rendering: PersonalDataRendering;
};

const PersonalData = ({ tag, value, rendering }: PersonalDataProps) => {
  const found = (
    <span
      className="bg-warning/15 rounded px-0.5"
      data-anonymization-preview="value"
    >
      {value}
    </span>
  );
  const masked = (
    <span
      className="bg-info/12 text-info rounded px-0.5"
      data-anonymization-preview="placeholder"
    >
      <bdi>{PLACEHOLDERS[tag]}</bdi>
    </span>
  );
  const restored = (
    <span
      className="bg-info/12 text-info rounded px-0.5"
      data-anonymization-preview="restored"
    >
      {value}
    </span>
  );

  switch (rendering) {
    case "found":
      return found;
    case "masked":
      return masked;
    case "masking":
      return (
        <AnimatedPreview
          inline
          pace="beat"
          stages={[
            { id: "value", content: found },
            { id: "placeholder", content: masked },
          ]}
          stagger={MASKING_ORDER[tag]}
        />
      );
    case "restoring":
      return (
        <AnimatedPreview
          inline
          pace="beat"
          stages={[
            { id: "placeholder", content: masked },
            { id: "value", content: restored },
          ]}
          stagger={MASKING_ORDER[tag]}
        />
      );
    default:
      rendering satisfies never;
      return panic(`Unhandled personal data rendering: ${String(rendering)}`);
  }
};

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
