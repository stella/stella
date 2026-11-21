import type { ReactNode } from "react";

import { useFormatter, useTranslations } from "use-intl";

import {
  ArrowRightIcon,
  CheckIcon,
  LockKeyholeIcon,
  SendIcon,
} from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";

import {
  ActivityDisclosure,
  useStoredFact,
} from "../activity/ActivityDisclosure";
import { PermissionsSection } from "../mainview/PermissionsSection";
import type { Permission } from "../shared/permissions";
import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import "./activity-story.css";

/** Sample apps of the illustrated morning, as shares of its length. */
const STORY_APPS = [
  { color: "var(--option-blue)", share: 0.44 },
  { color: "var(--option-sky)", share: 0.22 },
  { color: "var(--option-amber)", share: 0.34 },
] as const;

const STORY_MATTER_COLOR = "var(--option-emerald)";

/** Story length in hours, as the draft entry rounds it. */
const STORY_HOURS = 0.9;

type ActivityExplainerProps = {
  permissions: readonly Permission[];
};

/**
 * What activity records, where it stays and what leaves, told as the
 * morning it turns into a draft entry. Shared by the tour and by the
 * introduction shown when activity arrives later.
 */
export const ActivityExplainer = ({ permissions }: ActivityExplainerProps) => {
  const t = useTranslations("onboarding");
  const activity = useTranslations("activity");
  const format = useFormatter();
  const stored = useStoredFact();
  const askForDetails = DESKTOP_PLATFORM === "mac" && permissions.length > 0;

  return (
    // Longer translations scroll here, inside the window, rather than
    // squeezing a block below its own text.
    <ScrollArea axis="vertical">
      <div className="flex flex-col gap-4">
        <ol
          className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-2"
          data-activity-story=""
        >
          <StoryStage
            caption={stored}
            icon={<LockKeyholeIcon className="size-3" />}
            title={t("activityStoryRecordTitle")}
          >
            <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
              {STORY_APPS.map(({ color, share }) => (
                <span
                  className="h-full rounded-sm"
                  data-activity-story-bar=""
                  key={color}
                  style={{ backgroundColor: color, flexGrow: share }}
                />
              ))}
            </div>
          </StoryStage>
          <StoryArrow />
          <StoryStage
            caption={t("activityStoryReviewCaption")}
            icon={<CheckIcon className="size-3" />}
            title={t("activityStoryReviewTitle")}
          >
            {/* The sample matter wraps rather than truncates: a cut name
                reads as a fault in the illustration. */}
            <div
              className="bg-background flex items-start gap-1.5 rounded-lg border px-2 py-1.5"
              data-activity-story-matter=""
            >
              <span
                aria-hidden="true"
                className="mt-1 size-2 shrink-0 rounded-full"
                style={{ backgroundColor: STORY_MATTER_COLOR }}
              />
              <span className="min-w-0 text-xs leading-snug font-medium text-pretty wrap-break-word">
                {activity("welcomePreviewMatter")}
              </span>
            </div>
          </StoryStage>
          <StoryArrow />
          <StoryStage
            caption={t("activityStorySendCaption")}
            icon={<SendIcon className="size-3" />}
            title={t("activityStorySendTitle")}
          >
            <div
              className="bg-background flex flex-col gap-1 rounded-lg border px-2 py-1.5"
              data-activity-story-entry=""
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs bg-muted text-muted-foreground rounded-full px-1.5 py-px font-medium">
                  {t("activityStoryDraft")}
                </span>
                <span className="text-xs font-semibold tabular-nums">
                  {activity("hours", {
                    hours: format.number(STORY_HOURS, {
                      maximumFractionDigits: 1,
                      minimumFractionDigits: 1,
                    }),
                  })}
                </span>
              </div>
              <span className="bg-muted h-1.5 w-4/5 rounded-full" />
              <span className="bg-muted h-1.5 w-3/5 rounded-full" />
            </div>
          </StoryStage>
        </ol>

        <ActivityDisclosure />

        {askForDetails ? (
          <div className="bg-card rounded-xl border">
            <PermissionsSection
              only={permissions}
              window={DESKTOP_TELEMETRY_WINDOWS.onboarding}
            />
          </div>
        ) : null}

        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          {activity("disclosure.control")}
        </p>
      </div>
    </ScrollArea>
  );
};

type StoryStageProps = {
  caption: string;
  children: ReactNode;
  icon: ReactNode;
  title: string;
};

const StoryStage = ({ caption, children, icon, title }: StoryStageProps) => (
  <li
    className="bg-card flex min-w-0 flex-col rounded-xl border p-3 shadow-xs"
    data-activity-story-stage=""
  >
    <p className="flex items-center gap-1.5 text-xs font-semibold">
      <span
        aria-hidden="true"
        className="bg-primary/10 text-primary grid size-5 place-items-center rounded-full"
      >
        {icon}
      </span>
      {title}
    </p>
    <div aria-hidden="true" className="mt-3 flex-1">
      {children}
    </div>
    <p className="text-muted-foreground text-2xs mt-2 leading-snug text-pretty">
      {caption}
    </p>
  </li>
);

const StoryArrow = () => (
  <li
    aria-hidden="true"
    className="text-foreground-placeholder grid place-items-center"
    data-activity-story-arrow=""
  >
    <ArrowRightIcon className="size-3.5 rtl:-scale-x-100" />
  </li>
);
