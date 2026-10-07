import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { DatePickerPopover } from "../date-picker-popover";
import { Field, FieldLabel } from "../field";

const noop = () => undefined;

const DatePickerFixture = () => {
  const [dateTime, setDateTime] = useState<string | null>("2026-03-05T09:15");

  useEffect(() => {
    document.documentElement.dataset["datePickerReady"] = "true";
    return () => {
      delete document.documentElement.dataset["datePickerReady"];
    };
  }, []);

  return (
    <main className="grid gap-4">
      <Field>
        <FieldLabel id="field-label">Date</FieldLabel>
        <DatePickerPopover
          id="field"
          labelledBy="field-label"
          variant="field"
          locale="en-US"
          onChange={noop}
          value="2026-03-05"
        />
      </Field>
      <Field>
        <FieldLabel id="empty-field-label">Until</FieldLabel>
        <DatePickerPopover
          id="empty-field"
          labelledBy="empty-field-label"
          variant="field"
          locale="en-US"
          onChange={noop}
          value={null}
        />
      </Field>
      <DatePickerPopover
        clearLabel="Vymazat datum"
        dialogLabel="Výběr data"
        hideClear
        id="localized"
        locale="cs"
        nextDecadeLabel="Další desetiletí"
        nextMonthLabel="Další měsíc"
        nextYearLabel="Další rok"
        onChange={noop}
        previousDecadeLabel="Předchozí desetiletí"
        previousMonthLabel="Předchozí měsíc"
        previousYearLabel="Předchozí rok"
        value="2026-03-05"
      />

      <DatePickerPopover
        id="date-time"
        locale="en-US"
        mode="date-time"
        onChange={setDateTime}
        timeLabel="Start time"
        value={dateTime}
      />
      <output aria-label="Date-time value">{dateTime ?? "empty"}</output>

      <DatePickerPopover
        id="compact"
        locale="en-US"
        onChange={noop}
        value="2026-03-05"
      />
      <DatePickerPopover
        id="touch"
        locale="en-US"
        onChange={noop}
        size="touch"
        value="2026-03-05"
      />
    </main>
  );
};

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}

createRoot(rootElement).render(<DatePickerFixture />);
