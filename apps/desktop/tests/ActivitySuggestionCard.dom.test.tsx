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
      edit={{
        billable: true,
        classification: null,
        matter: MATTER,
        narrative: "Call with the landlord's counsel",
        undo: null,
        written: 0,
      }}
      editable
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
      <SelectedRangeCard onAccept={(minutes) => accepted.push(minutes)} />
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
    expect(accept.hasAttribute("disabled")).toBe(true);
    await testing.act(async () => {
      testing.fireEvent.click(accept);
    });
    expect(accepted).toEqual([]);
  });
});
