import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle } from "@expo/ui/swift-ui/modifiers";

import type { DueDatePickerProps } from "@/components/due-date-picker";
import { pickedDay, pickerDate, swiftUiClock } from "@/state/picked-day";

/** The system's own calendar, inline, as Reminders shows it for a date. */
export const DueDatePicker = ({
  day,
  earliest,
  onChange,
}: DueDatePickerProps) => {
  const clock = swiftUiClock();
  return (
    <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
      <DatePicker
        displayedComponents={["date"]}
        modifiers={[datePickerStyle("graphical")]}
        onDateChange={(date) => {
          onChange(pickedDay(date, clock));
        }}
        range={{
          start: pickerDate(earliest, { ...clock, plainTime: "00:00" }),
        }}
        selection={pickerDate(day, clock)}
      />
    </Host>
  );
};
