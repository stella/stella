import { useId } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Step, Steps } from "@stll/ui/steps";
import { Switch } from "@stll/ui/switch";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

/**
 * The pieces every one-choice-per-screen setup step is built from, so
 * Dictation and Activity look and read alike: the stepper above the title,
 * the title with one plain line, the screen's cards, a switch card, facts,
 * and the line that offers to read again.
 */

/** Grid columns for each number of screens, written out for Tailwind. */
const COLUMNS: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
};

const stepStatus = (index: number, position: number) => {
  if (index < position) {
    return "completed";
  }
  return index === position ? "current" : "upcoming";
};

/** Where the step is among its screens: a short bar per screen with its
 *  name, the current one in full ink. */
export const SetupStepper = ({
  label,
  names,
  position,
}: {
  label: string;
  /** Each screen's name, in order. */
  names: readonly string[];
  position: number;
}) => {
  const t = useTranslations("onboarding");
  return (
    <nav aria-label={label} className="mb-4">
      <p className="text-muted-foreground mb-1.5 text-xs font-medium">
        {label}
        <span className="sr-only">
          {" "}
          {t("progress", { current: position + 1, total: names.length })}
        </span>
      </p>
      <Steps
        className={cn("list-none ps-0", COLUMNS[names.length])}
        markerStyle="none"
        variant="progress"
      >
        {names.map((name, index) => (
          <Step
            aria-current={index === position ? "step" : undefined}
            className="min-w-0 ps-0 text-xs"
            key={name}
            status={stepStatus(index, position)}
          >
            <TruncatedText>{name}</TruncatedText>
          </Step>
        ))}
      </Steps>
    </nav>
  );
};

export const ScreenHeader = ({
  body,
  title,
}: {
  body: ReactNode;
  title: string;
}) => (
  <>
    <h1 className="text-xl font-semibold text-balance">{title}</h1>
    <p className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty">
      {body}
    </p>
  </>
);

/** The screen's cards, scrolling inside the window when they outgrow it. */
export const ScreenContent = ({ children }: { children: ReactNode }) => (
  <ScrollArea axis="vertical" className="mt-4">
    <div className="flex flex-col gap-3 pb-1">{children}</div>
  </ScrollArea>
);

/** A switch with its name and what it does, on a card of its own. */
export const SwitchCard = ({
  checked,
  description,
  disabled,
  onChange,
  title,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
  title: string;
}) => {
  const id = useId();
  return (
    <div className="bg-card flex items-center justify-between gap-4 rounded-xl border px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" id={`${id}-title`}>
          {title}
        </p>
        <p
          className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty"
          id={`${id}-description`}
        >
          {description}
        </p>
      </div>
      <Switch
        aria-describedby={`${id}-description`}
        aria-labelledby={`${id}-title`}
        checked={checked}
        disabled={disabled === true}
        onCheckedChange={onChange}
      />
    </div>
  );
};

/** What a screen sends and keeps, one plain line each. */
export const Facts = ({ facts }: { facts: readonly string[] }) => (
  <ul className="text-muted-foreground flex flex-col gap-1.5 px-1 text-sm">
    {facts.map((fact) => (
      <li className="flex gap-2" key={fact}>
        <span
          aria-hidden="true"
          className="bg-muted-foreground mt-2 size-1 shrink-0 rounded-full"
        />
        <span className="min-w-0 text-pretty">{fact}</span>
      </li>
    ))}
  </ul>
);

/** The state could not be read: says so and offers to read again. */
export const Unread = ({ onReload }: { onReload: () => void }) => {
  const t = useTranslations("onboarding");
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-destructive-foreground min-w-0 text-sm" role="alert">
        {t("errorLoad")}
      </p>
      <Button className="shrink-0" onClick={onReload} variant="outline">
        {t("tryAgain")}
      </Button>
    </div>
  );
};
