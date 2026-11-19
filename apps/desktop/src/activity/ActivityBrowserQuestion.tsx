import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CheckIcon, XIcon } from "@stll/ui/icons";

import type {
  ActivityAppExclusion,
  ActivityDaySnapshot,
} from "./activity-types";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import {
  captureModeCommands,
  dismissedBrowserKey,
  undecidedBrowser,
} from "./capture-modes";
import type { CaptureModeCommand } from "./capture-modes";

type BrowserChoice = "titles" | "appOnly";

type BrowserOutcome = { browser: ActivityAppExclusion; choice: BrowserChoice };

type RunBrowserCommand = (
  command: CaptureModeCommand["command"],
  args: CaptureModeCommand["args"],
  onSuccess: () => void,
  onFailure: () => void,
) => void;

const OUTCOME_KEYS = {
  titles: "browserAnsweredTitles",
  appOnly: "browserAnsweredAppNameOnly",
} as const satisfies Record<BrowserChoice, string>;

/**
 * What the browser question remembers while the Activity window is open:
 * browsers whose question was answered or put off, the browser whose answer
 * is being saved, and the answer to confirm. Nothing is stored: a browser
 * put off is asked about again the next time the window opens, and an
 * answered one is no longer undecided.
 */
export const useBrowserQuestion = () => {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BrowserOutcome | null>(null);
  return {
    dismissed,
    dismiss: (browser: ActivityAppExclusion) =>
      setDismissed(
        (previous) =>
          new Set([...previous, dismissedBrowserKey(browser.identifier)]),
      ),
    outcome,
    setOutcome,
    pending,
    setPending,
  };
};

type BrowserQuestionProps = {
  onCommand: RunBrowserCommand;
  snapshot: ActivityDaySnapshot;
  state: ReturnType<typeof useBrowserQuestion>;
};

/**
 * Asks once per browser whether its tab titles may be recorded. It appears
 * only with details on, for a browser in the day's activity that is neither
 * chosen for titles nor set to its name; until then the browser records its
 * name only. Either answer uses the settings commands Settings uses.
 */
export const BrowserQuestion = ({
  onCommand,
  snapshot,
  state,
}: BrowserQuestionProps) => {
  const t = useTranslations("activity");
  const browser = undecidedBrowser(snapshot, state.dismissed);
  if (browser === null) {
    return state.outcome === null ? null : (
      <BrowserOutcomeLine
        onDismiss={() => state.setOutcome(null)}
        outcome={state.outcome}
      />
    );
  }
  const answer = (choice: BrowserChoice) => {
    const [first, ...rest] = captureModeCommands(snapshot, browser, choice);
    const settle = () => {
      state.setPending(null);
      state.dismiss(browser);
      state.setOutcome({ browser, choice });
    };
    if (first === undefined) {
      settle();
      return;
    }
    state.setPending(browser.identifier);
    const send = (
      next: CaptureModeCommand,
      remaining: CaptureModeCommand[],
    ) => {
      onCommand(
        next.command,
        next.args,
        () => {
          const [following, ...after] = remaining;
          if (following === undefined) {
            settle();
            return;
          }
          send(following, after);
        },
        () => state.setPending(null),
      );
    };
    send(first, rest);
  };
  const pending = state.pending === browser.identifier;
  const bdi = (chunks: ReactNode) => <bdi dir="auto">{chunks}</bdi>;
  return (
    <section
      aria-labelledby="activity-browser-question"
      className="flex flex-col gap-3 rounded-xl border px-4 py-3"
      data-activity-browser-question=""
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex">
          <ActivitySourceIcon
            appIdentifier={browser.identifier}
            sourceAppVisuals={snapshot.sourceAppVisuals}
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2
            className="text-sm font-medium text-balance"
            id="activity-browser-question"
          >
            {t.rich("browserQuestionTitle", { bdi, browser: browser.name })}
          </h2>
          <p className="text-muted-foreground text-xs text-pretty">
            {t("browserQuestionDescription")}
          </p>
        </div>
        <Button
          aria-label={t("browserQuestionLater")}
          className="-me-2 -mt-1"
          disabled={pending}
          onClick={() => state.dismiss(browser)}
          size="icon-sm"
          tooltip={t("browserQuestionLater")}
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2 ps-7">
        <Button
          disabled={pending}
          onClick={() => answer("titles")}
          size="sm"
          variant="outline"
        >
          {t("browserQuestionRecordTitles")}
        </Button>
        <Button
          disabled={pending}
          onClick={() => answer("appOnly")}
          size="sm"
          variant="outline"
        >
          {t("browserQuestionAppNameOnly")}
        </Button>
      </div>
    </section>
  );
};

/** Confirms the answer in the question's place and says where to change it;
 * it takes focus so the keyboard does not fall back to the window start. */
const BrowserOutcomeLine = ({
  onDismiss,
  outcome,
}: {
  onDismiss: () => void;
  outcome: BrowserOutcome;
}) => {
  const t = useTranslations("activity");
  const tDialog = useTranslations("dialog");
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    line.current?.focus();
  }, []);
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-xs">
      <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <p
        className="min-w-0 flex-1 text-pretty outline-none"
        ref={line}
        role="status"
        tabIndex={-1}
      >
        {t.rich(OUTCOME_KEYS[outcome.choice], {
          bdi: (chunks) => <bdi dir="auto">{chunks}</bdi>,
          browser: outcome.browser.name,
        })}
      </p>
      <Button
        aria-label={tDialog("close")}
        onClick={onDismiss}
        size="icon-sm"
        tooltip={tDialog("close")}
        variant="ghost"
      >
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
};
