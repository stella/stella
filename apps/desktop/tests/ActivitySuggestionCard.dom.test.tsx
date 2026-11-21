import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const testing = await import("@testing-library/react");
const { useState } = await import("react");
const { Temporal } = await import("@stll/time");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { manualSuggestion } =
  await import("../src/activity/activity-calendar-logic");
const { ActivitySuggestionCard } =
  await import("../src/activity/ActivitySuggestionCard");

afterEach(() => {
  testing.cleanup();
});

afterAll(async () => {
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

/** The card for a range the user dragged out on the grid, with the range
 * held where the calendar holds it. */
const SelectedRangeCard = ({
  onAccept,
}: {
  onAccept: (durationMinutes: number) => void;
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
      onAccept={() => onAccept(suggestion.roundedTenths * 6)}
      onAcceptProposal={noop}
      onAcceptStructure={noop}
      onAllow={noop}
      onClose={noop}
      onCopy={async () => true}
      onDismissProposal={noop}
      onDraft={noop}
      onEdit={noop}
      onRefine={noop}
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

describe("the stella AI consent on a card", () => {
  const renderConsent = () => {
    const allowed: true[] = [];
    testing.render(
      <DesktopIntlProvider language="en" messages={defaultMessages}>
        <ActivitySuggestionCard
          assist={{ pending: false, type: "consent" }}
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
          onAccept={noop}
          onAcceptProposal={noop}
          onAcceptStructure={noop}
          onAllow={() => {
            allowed.push(true);
          }}
          onClose={noop}
          onCopy={async () => true}
          onDismissProposal={noop}
          onDraft={noop}
          onEdit={noop}
          onRefine={noop}
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
      </DesktopIntlProvider>,
    );
    return { allowed };
  };
  const isShown = (element: HTMLElement) =>
    element.closest("[hidden]") === null;

  test("asks in one line and shows everything a draft sends on request", async () => {
    renderConsent();
    expect(testing.screen.getByText(messages.aiDraftOffer)).toBeDefined();
    const details = testing.screen.queryByText(messages.aiDraftConsent);
    expect(details === null || !isShown(details)).toBe(true);

    const whatIsSent = testing.screen.getByRole("button", {
      name: messages.aiDraftWhatIsSent,
    });
    expect(whatIsSent.getAttribute("aria-expanded")).toBe("false");
    await testing.act(async () => {
      testing.fireEvent.click(whatIsSent);
    });
    expect(whatIsSent.getAttribute("aria-expanded")).toBe("true");
    expect(isShown(testing.screen.getByText(messages.aiDraftConsent))).toBe(
      true,
    );
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
});

const { DRAFT_FAILURE_KINDS, DRAFT_FAILURE_RECOVERY } =
  await import("../src/activity/billing-draft-logic");

type CardProps = React.ComponentProps<typeof ActivitySuggestionCard>;

/** A recorded card for MATTER showing `assist`, recording what it calls. */
const renderAssist = (assist: CardProps["assist"]) => {
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
      const { calls } = renderAssist({ kind, type: "failed" });
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
      testing.cleanup();
    }
  });

  test("consent that is missing is asked for again, not retried", () => {
    renderAssist({ kind: "consentRequired", type: "failed" });
    expect(
      testing.screen.getByRole("button", { name: messages.aiDraftAllow }),
    ).toBeDefined();
    expect(
      testing.screen.queryByRole("button", { name: messages.aiDraftRetry }),
    ).toBeNull();
  });

  test("a matter drafting refused cannot get an entry from the card either", async () => {
    const { calls } = renderAssist({ kind: "refused", type: "failed" });
    const accept = testing.screen.getByRole("button", {
      name: new RegExp(messages.accept, "u"),
    });
    expect(accept.getAttribute("aria-disabled")).toBe("true");
    await testing.act(async () => {
      testing.fireEvent.click(accept);
    });
    expect(calls).toEqual([]);
  });

  test("a firm that switched drafting off is said quietly, with nothing to draft", () => {
    renderAssist({ kind: "off", type: "failed" });
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

  test("offers to write in the window's language only when the draft is in another", () => {
    const languageChip = { name: messages.aiSteerWriteInLanguage };
    renderAssist(ready("en-GB"));
    expect(testing.screen.queryByRole("button", languageChip)).toBeNull();
    testing.cleanup();

    renderAssist(ready("cs"));
    expect(testing.screen.getByRole("button", languageChip)).toBeDefined();
  });

  test("keeps the description above every stella AI control", () => {
    renderAssist(ready("en"));
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

  test("a proposal applies the change under its own name, not the card's Accept", () => {
    renderAssist({
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
