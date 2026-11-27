import { createContext, use, useId } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Label } from "@stll/ui/label";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Switch } from "@stll/ui/switch";

/**
 * The pieces every one-choice-per-screen setup step is built from, so
 * Dictation and Activity look and read like the rest of setup: the title
 * with one plain line, the screen's cards, a switch card, a choice and its
 * cards, facts, and the line that offers to read again. Only this file draws
 * radios and choice cards (`no-hand-rolled-setup-choice`). Where a screen is among
 * the others shows in the footer's dots (`StepFooter`).
 */

/** Above the title of a setup opened on its own after the tour, such as
 *  "New: dictation": what arrived. */
export const IntroductionLabel = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground mb-1.5 text-xs font-medium">{children}</p>
);

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

/**
 * The screen's cards, scrolling inside the window when they outgrow it.
 * The scroll clips at its edges, and a card draws its edge, its shadow and
 * its focus ring outside its box: the cards sit one inset in from every
 * edge, and the area reaches out by as much, so they line up with the title
 * and still show whole.
 */
export const ScreenContent = ({ children }: { children: ReactNode }) => (
  <ScrollArea axis="vertical" className="-mx-1 mt-3">
    <div className="flex flex-col gap-3 p-1">{children}</div>
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

/** The `name` the radios of one choice share. */
const ChoiceName = createContext<string | null>(null);

/** One choice: its cards in one radio group named `label`, so the arrow
 *  keys move between the answers and Tab enters and leaves the group. */
export const ChoiceGroup = ({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) => {
  const name = useId();
  return (
    <ChoiceName value={name}>
      <div aria-label={label} className="flex flex-col gap-3" role="radiogroup">
        {children}
      </div>
    </ChoiceName>
  );
};

/** One answer of a choice with its name and what it means, as a card of
 *  its own inside a `ChoiceGroup`. A `note` says why an answer is not
 *  offered; `details` sit under the card, lined up with its text, for
 *  controls that belong to the answer (a download, a model). */
export const ChoiceCard = ({
  checked,
  description,
  details,
  disabled = false,
  note,
  onChoose,
  title,
  value,
}: {
  checked: boolean;
  description: string;
  details?: ReactNode;
  disabled?: boolean;
  note?: string | undefined;
  onChoose: () => void;
  title: string;
  value: string;
}) => {
  const name = use(ChoiceName) ?? panic("A ChoiceCard needs a ChoiceGroup");
  const card = (
    <Label variant="choice-card">
      <input
        checked={checked}
        className="accent-primary mt-0.5 size-4 shrink-0"
        disabled={disabled}
        name={name}
        onChange={onChoose}
        type="radio"
        value={value}
      />
      <span className="min-w-0">
        <span className="text-foreground block text-sm font-medium">
          {title}
        </span>
        <span className="text-muted-foreground mt-0.5 block text-sm leading-relaxed text-pretty">
          {description}
        </span>
        {note === undefined ? null : (
          <span
            className="text-muted-foreground mt-1 block text-xs"
            role="note"
          >
            {note}
          </span>
        )}
      </span>
    </Label>
  );
  if (details === undefined) {
    return card;
  }
  // The card's padding, radio and gap: the details start where its text does.
  return (
    <div className="flex flex-col gap-2">
      {card}
      <div className="ps-10">{details}</div>
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
