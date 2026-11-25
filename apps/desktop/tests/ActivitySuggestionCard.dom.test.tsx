import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { DraftConsentStatus } from "../src/activity/billing-draft-transport";

GlobalRegistrator.register({ url: "http://localhost/" });

const testing = await import("@testing-library/react");
const { useState } = await import("react");
const { Temporal } = await import("@stll/time");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { manualSuggestion } =
  await import("../src/activity/activity-calendar-logic");
const { ActivitySuggestionCard } =
  await import("../src/activity/ActivitySuggestionCard");
const { useBillingDraftSettings } =
  await import("../src/activity/billing-draft-settings");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");

/** One macrotask, for React's scheduler and the scroll area's updates. */
const nextMacrotask = async () =>
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

afterEach(async () => {
  await testing.act(nextMacrotask);
  testing.cleanup();
  clearMocks();
  localStorage.clear();
});

afterAll(async () => {
  await nextMacrotask();
  await GlobalRegistrator.unregister();
});

const messages = defaultMessages.activity;
const TIME_ZONE = "Europe/Prague";
const DATE = "2026-10-09";
const wall = (time: string) =>
  Temporal.PlainDate.from(DATE).toZonedDateTime({
    plainTime: Temporal.PlainTime.from(time),
    timeZone: TIME_ZONE,
  }).epochMilliseconds;
const MATTER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Riverside lease renewal",
  reference: null,
  color: null,
};
const noop = () => undefined;
/** No time on the card's matter from another computer or the web. */
const NOTHING_ELSEWHERE = {
  dayEntries: { type: "ready", entries: [] },
  draftedEntries: [],
  day: "today",
  onReview: noop,
  onRetry: noop,
} satisfies CardProps["recordedElsewhere"];

/** The card for a range the user dragged out on the grid, with the range
 * held where the calendar holds it. */
const SelectedRangeCard = ({
  onAccept,
  recordedElsewhere = NOTHING_ELSEWHERE,
}: {
  onAccept: (durationMinutes: number) => void;
  recordedElsewhere?: CardProps["recordedElsewhere"];
}) => {
  const [range, setRange] = useState({
    startMs: wall("10:00"),
    endMs: wall("10:30"),
  });
  const suggestion = manualSuggestion({
    drafted: [],
    id: "manual:grid",
    range,
    segments: [],
  });
  return (
    <ActivitySuggestionCard
      assist={{ type: "hidden" }}
      candidates={[]}
      earlierEntries={[]}
      codeNames={[]}
      edit={{
        billable: true,
        classification: null,
        matter: MATTER,
        narrative: "Call with the landlord's counsel",
        undo: null,
        written: 0,
      }}
      flags={[]}
      recordedElsewhere={recordedElsewhere}
      onAccept={() => onAccept(suggestion.workedMinutes)}
      onAcceptProposal={noop}
      onAcceptStructure={noop}
      onAllow={noop}
      onClose={noop}
      onCopy={async () => true}
      onDismissProposal={noop}
      onDraft={noop}
      onEdit={noop}
      onRefine={noop}
      onIncludeSlivers={noop}
      onReject={noop}
      onRestoreTemplate={noop}
      onUndo={noop}
      sourceAppVisuals={[]}
      structure={null}
      suggestion={suggestion}
      timeLabel=""
      titlesNotice={null}
      times={{
        date: DATE,
        onRangeChange: setRange,
        range,
        timeZone: TIME_ZONE,
        type: "selected",
      }}
    />
  );
};

const renderCard = () => {
  const accepted: number[] = [];
  const view = testing.render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <SelectedRangeCard
        onAccept={(minutes) => {
          accepted.push(minutes);
        }}
      />
    </DesktopIntlProvider>,
  );
  return { accepted, view };
};

/** Picks `option` in the hour or minute select of the Start or End field. */
const choose = async (
  field: string,
  part: "Hour" | "Minute",
  option: string,
) => {
  const group = testing.screen.getByRole("group", { name: field });
  const trigger = testing.within(group).getByRole("combobox", { name: part });
  await testing.act(async () => {
    testing.fireEvent.click(trigger);
  });
  // Closed lists may stay mounted; the open one is the trigger's.
  const listbox = await testing.waitFor(() => {
    const popup = testing.screen
      .getAllByRole("listbox")
      .find(({ id }) => id === trigger.getAttribute("aria-controls"));
    if (popup === undefined) {
      throw new TypeError(`The ${field} ${part} list did not open`);
    }
    return popup;
  });
  const choice = testing.within(listbox).getByRole("option", { name: option });
  // A press that starts on the option, as a pointer makes it.
  await testing.act(async () => {
    testing.fireEvent.pointerDown(choice, { pointerType: "mouse" });
    testing.fireEvent.click(choice);
  });
};

describe("a selected range's card", () => {
  test("sets the entry's start and end to the minute and creates exactly that time", async () => {
    const { accepted } = renderCard();
    const accept = testing.screen.getByRole("button", {
      name: new RegExp(messages.accept, "u"),
    });

    await choose(messages.entryStart, "Minute", "03");
    // A new start moves the range: 10:03 to 10:33.
    const end = testing.screen.getByRole("group", { name: messages.entryEnd });
    expect(
      testing.within(end).getByRole("combobox", { name: "Minute" }).textContent,
    ).toBe("33");
    expect(testing.screen.getByText("30 min")).toBeDefined();
    await choose(messages.entryEnd, "Minute", "15");
    expect(testing.screen.getByText("12 min")).toBeDefined();

    await testing.act(async () => {
      testing.fireEvent.click(accept);
    });
    expect(accepted).toEqual([12]);
  });

  test("an end before the start is reported at the field and cannot be accepted", async () => {
    const { accepted } = renderCard();
    await choose(messages.entryEnd, "Hour", "9 AM");

    const error = testing.screen.getByText(messages.rangeEndBeforeStart);
    const end = testing.screen.getByRole("group", { name: messages.entryEnd });
    expect(end.getAttribute("aria-describedby")).toBe(error.id);
    const accept = testing.screen.getByRole("button", {
      name: new RegExp(messages.accept, "u"),
    });
    expect(accept.getAttribute("aria-disabled")).toBe("true");
    await testing.act(async () => {
      testing.fireEvent.click(accept);
    });
    expect(accepted).toEqual([]);
  });
});

describe("time on the matter from another computer or the web", () => {
  test("is named with a link to the day in stella web, and the card can still be accepted", async () => {
    const accepted: number[] = [];
    let reviewed = 0;
    testing.render(
      <DesktopIntlProvider language="en" messages={defaultMessages}>
        <SelectedRangeCard
          onAccept={(minutes) => {
            accepted.push(minutes);
          }}
          recordedElsewhere={{
            dayEntries: {
              type: "ready",
              entries: [
                { id: "laptop", matterId: MATTER.id, durationMinutes: 60 },
                { id: "web", matterId: MATTER.id, durationMinutes: 30 },
                { id: "here", matterId: MATTER.id, durationMinutes: 45 },
              ],
            },
            // This computer's own entry is not time from elsewhere.
            draftedEntries: [
              {
                start: new Date(wall("09:00")).toISOString(),
                end: new Date(wall("09:45")).toISOString(),
                entryId: "here",
              },
            ],
            day: "today",
            onReview: () => {
              reviewed += 1;
            },
            onRetry: noop,
          }}
        />
      </DesktopIntlProvider>,
    );
    await testing.act(nextMacrotask);
    expect(
      testing.screen.getByText(
        "1 h 30 min already recorded on this matter today on another computer or the web.",
      ),
    ).toBeDefined();
    await testing.act(async () => {
      testing.fireEvent.click(
        testing.screen.getByRole("button", {
          name: messages.recordedElsewhereReview,
        }),
      );
    });
    expect(reviewed).toBe(1);
    await testing.act(async () => {
      testing.fireEvent.click(
        testing.screen.getByRole("button", {
          name: new RegExp(messages.accept, "u"),
        }),
      );
    });
    expect(accepted).toEqual([30]);
  });

  test("a day that could not be read says so and offers to try again", async () => {
    let retries = 0;
    testing.render(
      <DesktopIntlProvider language="en" messages={defaultMessages}>
        <SelectedRangeCard
          onAccept={noop}
          recordedElsewhere={{
            dayEntries: { type: "failed" },
            draftedEntries: [],
            day: "other",
            onReview: noop,
            onRetry: () => {
              retries += 1;
            },
          }}
        />
      </DesktopIntlProvider>,
    );
    await testing.act(nextMacrotask);
    const note = testing.screen.getByText(messages.recordedElsewhereUnknown);
    await testing.act(async () => {
      testing.fireEvent.click(
        testing.within(note).getByRole("button", { name: messages.retry }),
      );
    });
    expect(retries).toBe(1);
  });
});

/** A card asking for consent, as the calendar shows it. */
const ConsentCard = ({
  consent,
  onAllow,
}: {
  consent: DraftConsentStatus;
  onAllow: () => void;
}) => (
  <ActivitySuggestionCard
    assist={{ consent, type: "consent" }}
    candidates={[]}
    codeNames={[]}
    earlierEntries={[]}
    edit={{
      billable: true,
      classification: null,
      matter: MATTER,
      narrative: "Call with the landlord's counsel",
      undo: null,
      written: 0,
    }}
    flags={[]}
    recordedElsewhere={NOTHING_ELSEWHERE}
    onAccept={noop}
    onAcceptProposal={noop}
    onAcceptStructure={noop}
    onAllow={onAllow}
    onClose={noop}
    onCopy={async () => true}
    onDismissProposal={noop}
    onDraft={noop}
    onEdit={noop}
    onRefine={noop}
    onIncludeSlivers={noop}
    onReject={noop}
    onRestoreTemplate={noop}
    onUndo={noop}
    sourceAppVisuals={[]}
    titlesNotice={null}
    structure={null}
    suggestion={manualSuggestion({
      drafted: [],
      id: "manual:consent",
      range: { startMs: wall("10:00"), endMs: wall("10:30") },
      segments: [],
    })}
    timeLabel=""
    times={{ type: "recorded" }}
  />
);

/** The consent's own text: the disclosure's inputs and provider, in it. */
const consentText = () =>
  testing.screen.queryByText((content) =>
    content.includes(messages.disclosure.aiDraftProvider),
  );

describe("the stella AI consent on a card", () => {
  const renderConsent = () => {
    const allowed: true[] = [];
    testing.render(
      <DesktopIntlProvider language="en" messages={defaultMessages}>
        <ConsentCard
          consent="revoked"
          onAllow={() => {
            allowed.push(true);
          }}
        />
      </DesktopIntlProvider>,
    );
    return { allowed };
  };
  const isShown = (element: HTMLElement) =>
    element.closest("[hidden]") === null;

  test("asks in one line and shows everything a draft sends on request", async () => {
    renderConsent();
    expect(testing.screen.getByText(messages.aiDraftOffer)).toBeDefined();
    const details = consentText();
    expect(details === null || !isShown(details)).toBe(true);

    const whatIsSent = testing.screen.getByRole("button", {
      name: messages.aiDraftWhatIsSent,
    });
    expect(whatIsSent.getAttribute("aria-expanded")).toBe("false");
    await testing.act(async () => {
      testing.fireEvent.click(whatIsSent);
    });
    expect(whatIsSent.getAttribute("aria-expanded")).toBe("true");
    const shown = consentText();
    expect(shown !== null && isShown(shown)).toBe(true);
    // Every input the disclosure lists is in it.
    for (const input of Object.values(messages.disclosure.aiDraftInputs)) {
      expect(shown?.textContent).toContain(input);
    }
    expect(shown?.textContent).not.toContain("{");
  });

  test("Allow grants consent once, whether or not the details are open", async () => {
    const { allowed } = renderConsent();
    const allow = testing.screen.getByRole("button", {
      name: messages.aiDraftAllow,
    });
    await testing.act(async () => {
      testing.fireEvent.click(allow);
    });
    expect(allowed).toEqual([true]);
  });

  test("a grant the server refuses frees Allow, says so, and a retry grants it", async () => {
    const SCOPE_KEY = '["org_card","user_card"]';
    const server: { consent: "granted" | "revoked"; grantRefusals: number } = {
      consent: "revoked",
      grantRefusals: 1,
    };
    const scoped = () => ({
      policy: "account",
      scopeKey: SCOPE_KEY,
      settings: {
        consent: server.consent,
        effectiveMode: "plain",
        preference: null,
        revision: "revision-1",
      },
    });
    mockIPC((command) => {
      switch (command) {
        case "billing_draft_get_settings":
          return scoped();
        case "billing_draft_grant_consent":
          if (server.grantRefusals > 0) {
            server.grantRefusals -= 1;
            throw new TypeError("draft time entry is unavailable");
          }
          server.consent = "granted";
          return scoped();
        default:
          // Telemetry and other bookkeeping the window sends.
          return null;
      }
    });
    const OwnedConsentCard = () => {
      const drafting = useBillingDraftSettings(true);
      // The calendar asks once the account's settings are read.
      return drafting.settings.type === "ready" ? (
        <ConsentCard
          consent={drafting.settings.consent}
          onAllow={() => {
            void drafting.setConsent("granted");
          }}
        />
      ) : null;
    };
    testing.render(
      <DesktopIntlProvider language="en" messages={defaultMessages}>
        <OwnedConsentCard />
      </DesktopIntlProvider>,
    );
    const allow = () =>
      testing.screen.getByRole("button", { name: messages.aiDraftAllow });
    const busy = () => allow().getAttribute("aria-busy") === "true";
    await testing.waitFor(() => {
      expect(allow()).toBeDefined();
    });

    await testing.act(async () => {
      testing.fireEvent.click(allow());
    });
    expect((await testing.screen.findByRole("alert")).textContent).toBe(
      messages.errorUpdate,
    );
    expect(server.consent).toBe("revoked");
    expect(busy()).toBe(false);

    await testing.act(async () => {
      testing.fireEvent.click(allow());
    });
    await testing.waitFor(() => {
      expect(server.consent).toBe("granted");
    });
    await testing.waitFor(() => {
      expect(testing.screen.queryByRole("alert")).toBeNull();
    });
    expect(busy()).toBe(false);
  });
});

const { DRAFT_FAILURE_KINDS, DRAFT_FAILURE_RECOVERY } =
  await import("../src/activity/billing-draft-logic");

type CardProps = React.ComponentProps<typeof ActivitySuggestionCard>;

/** A recorded card for MATTER showing `assist`, recording what it calls. */
const renderAssist = async (assist: CardProps["assist"]) => {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  testing.render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <ActivitySuggestionCard
        assist={assist}
        candidates={[]}
        codeNames={[]}
        earlierEntries={[]}
        edit={{
          billable: true,
          classification: null,
          matter: MATTER,
          narrative: "Call with the landlord's counsel",
          undo: null,
          written: 0,
        }}
        flags={[]}
        recordedElsewhere={NOTHING_ELSEWHERE}
        onAccept={record("accept")}
        onAcceptProposal={record("acceptProposal")}
        onAcceptStructure={noop}
        onAllow={record("allow")}
        onClose={noop}
        onCopy={async () => true}
        onDismissProposal={noop}
        onDraft={record("draft")}
        onEdit={noop}
        onRefine={noop}
        onIncludeSlivers={noop}
        onReject={noop}
        onRestoreTemplate={noop}
        onUndo={noop}
        sourceAppVisuals={[]}
        titlesNotice={null}
        structure={null}
        suggestion={manualSuggestion({
          drafted: [],
          id: "manual:assist",
          range: { startMs: wall("10:00"), endMs: wall("10:30") },
          segments: [],
        })}
        timeLabel=""
        times={{ type: "recorded" }}
      />
    </DesktopIntlProvider>,
  );
  // Let the scroll area settle inside act, so no update outlives the test.
  await testing.act(nextMacrotask);
  return { calls };
};

/** What the one offered action calls back, per recovery. */
const RECOVERY_CALL = {
  allow: "allow",
  retry: "draft",
  none: null,
} as const;

describe("a failed draft", () => {
  test("every kind says why in one layout and offers only the action that can work", async () => {
    for (const kind of DRAFT_FAILURE_KINDS) {
      const { calls } = await renderAssist({ kind, type: "failed" });
      const failure = document.querySelector(
        `[data-activity-draft-failure="${kind}"]`,
      );
      expect(failure).not.toBeNull();
      const buttons = [...(failure?.querySelectorAll("button") ?? [])];
      const expected = RECOVERY_CALL[DRAFT_FAILURE_RECOVERY[kind]];
      expect(buttons).toHaveLength(expected === null ? 0 : 1);
      for (const button of buttons) {
        await testing.act(async () => {
          testing.fireEvent.click(button);
        });
      }
      expect(calls).toEqual(expected === null ? [] : [expected]);
      await testing.act(nextMacrotask);
      testing.cleanup();
    }
  });

  test("consent that is missing is asked for again, not retried", async () => {
    await renderAssist({ kind: "consentRequired", type: "failed" });
    expect(
      testing.screen.getByRole("button", { name: messages.aiDraftAllow }),
    ).toBeDefined();
    expect(
      testing.screen.queryByRole("button", { name: messages.aiDraftRetry }),
    ).toBeNull();
  });

  test("a matter drafting refused cannot get an entry from the card either", async () => {
    const { calls } = await renderAssist({ kind: "refused", type: "failed" });
    const accept = testing.screen.getByRole("button", {
      name: new RegExp(messages.accept, "u"),
    });
    expect(accept.getAttribute("aria-disabled")).toBe("true");
    await testing.act(async () => {
      testing.fireEvent.click(accept);
    });
    expect(calls).toEqual([]);
  });

  test("a refusal of AI access says so and leaves the entry to be written by hand", async () => {
    const { calls } = await renderAssist({
      kind: "aiUnavailable",
      type: "failed",
    });
    expect(testing.screen.getByText(messages.aiDraftUnavailable)).toBeDefined();
    const accept = testing.screen.getByRole("button", {
      name: new RegExp(messages.accept, "u"),
    });
    expect(accept.getAttribute("aria-disabled")).not.toBe("true");
    await testing.act(async () => {
      testing.fireEvent.click(accept);
    });
    expect(calls).toEqual(["accept"]);
  });

  test("a firm that switched drafting off is said quietly, with nothing to draft", async () => {
    await renderAssist({ kind: "off", type: "failed" });
    expect(testing.screen.getByText(messages.aiDraftOff)).toBeDefined();
    expect(
      testing.screen.queryByRole("button", { name: messages.aiDraftWrite }),
    ).toBeNull();
  });
});

describe("a draft in place", () => {
  const ready = (narrativeLanguage: string): CardProps["assist"] => ({
    canRestoreTemplate: true,
    canUndo: false,
    draft: { narrativeLanguage },
    refineFailure: null,
    type: "ready",
  });

  test("offers to write in the window's language only when the draft is in another", async () => {
    const languageChip = { name: messages.aiSteerWriteInLanguage };
    await renderAssist(ready("en-GB"));
    expect(testing.screen.queryByRole("button", languageChip)).toBeNull();
    await testing.act(nextMacrotask);
    testing.cleanup();

    await renderAssist(ready("cs"));
    expect(testing.screen.getByRole("button", languageChip)).toBeDefined();
  });

  test("keeps the description above every stella AI control", async () => {
    await renderAssist(ready("en"));
    const narrative = testing.screen.getByRole("textbox", {
      name: messages.entryNarrative,
    });
    const draftAgain = testing.screen.getByRole("button", {
      name: messages.aiDraftAgain,
    });
    expect(narrative.compareDocumentPosition(draftAgain)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test("a proposal applies the change under its own name, not the card's Accept", async () => {
    await renderAssist({
      after: "Shorter.",
      before: "Longer text.",
      type: "proposal",
    });
    const proposal = testing.screen.getByRole("region", {
      name: messages.aiProposal,
    });
    const apply = testing.within(proposal).getByRole("button", {
      name: messages.aiApplyChange,
    });
    expect(apply.textContent).not.toContain(messages.accept);
  });
});
