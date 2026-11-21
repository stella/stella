import { useId } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { CheckIcon, SendIcon, XIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import {
  ACTIVITY_NEVER_RECORDED,
  ACTIVITY_RECORDED,
  ACTIVITY_SENT,
} from "./activity-disclosure";

/** Where recorded activity is kept, as this platform names the computer. */
export const useStoredFact = () => {
  const t = useTranslations("activity.disclosure");
  return DESKTOP_PLATFORM === "mac" ? t("storedMac") : t("storedPc");
};

/**
 * What Activity records, what it never records, and what leaves the
 * computer: the facts of `activity-disclosure`, in one layout for setup,
 * the introduction and the Activity window's welcome.
 */
export const ActivityDisclosure = () => {
  const t = useTranslations("activity.disclosure");
  return (
    <div className="flex flex-col gap-4 text-xs" data-activity-disclosure="">
      <div className="grid grid-cols-2 gap-x-6">
        <FactList title={t("recordedTitle")}>
          {ACTIVITY_RECORDED.map((fact) => (
            <Fact key={fact} kind="recorded" text={t(`recorded.${fact}`)} />
          ))}
        </FactList>
        <FactList title={t("neverTitle")}>
          {ACTIVITY_NEVER_RECORDED.map((fact) => (
            <Fact key={fact} kind="never" text={t(`never.${fact}`)} />
          ))}
        </FactList>
      </div>
      <FactList title={t("sentTitle")}>
        <ActivitySentFacts />
      </FactList>
    </div>
  );
};

/** What leaves the computer, and only on a request: the facts alone, for
 *  a place that already has a heading. */
export const ActivitySentFacts = () => {
  const t = useTranslations("activity.disclosure");
  return ACTIVITY_SENT.map((fact) => (
    <Fact key={fact} kind="sent" text={t(`sent.${fact}`)} />
  ));
};

/** A titled list; the title is a label, not a heading, since the
 *  surfaces around it set their own heading levels. */
const FactList = ({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) => {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-foreground font-medium" id={id}>
        {title}
      </p>
      <ul aria-labelledby={id} className="flex flex-col gap-1.5">
        {children}
      </ul>
    </div>
  );
};

const FACT_ICONS = {
  never: XIcon,
  recorded: CheckIcon,
  sent: SendIcon,
} as const;

const Fact = ({
  kind,
  text,
}: {
  kind: keyof typeof FACT_ICONS;
  text: string;
}) => {
  const Icon = FACT_ICONS[kind];
  return (
    <li className="text-muted-foreground flex items-start gap-1.5 leading-snug text-pretty">
      <span
        aria-hidden="true"
        className={cn(
          "mt-px grid size-3.5 shrink-0 place-items-center rounded-full",
          kind === "recorded"
            ? "bg-success/15 text-success-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="size-2.5" />
      </span>
      {text}
    </li>
  );
};
