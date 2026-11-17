import { DateTimePicker, Host } from "@expo/ui/jetpack-compose";

import { MATERIAL_CLOCK, pickedDay, pickerDate } from "@/state/picked-day";

export type DueDatePickerProps = {
  /** The chosen day, YYYY-MM-DD. */
  readonly day: string;
  /** The first day it offers, YYYY-MM-DD. */
  readonly earliest: string;
  readonly onChange: (day: string) => void;
};

/** Material's calendar, inline; iOS has its own in the `.ios` file. */
export const DueDatePicker = ({
  day,
  earliest,
  onChange,
}: DueDatePickerProps) => (
  <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
    <DateTimePicker
      displayedComponents="date"
      initialDate={pickerDate(day, MATERIAL_CLOCK).toISOString()}
      onDateSelected={(date) => {
        // Material reports null while typed input is incomplete or invalid;
        // the chosen day stays until the input names a real date.
        if (date !== null) {
          onChange(pickedDay(date, MATERIAL_CLOCK));
        }
      }}
      selectableDates={{ start: pickerDate(earliest, MATERIAL_CLOCK) }}
      showVariantToggle={false}
      variant="picker"
    />
  </Host>
);
