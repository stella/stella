import type { DueDatePickerProps } from "@/components/due-date-picker";

/**
 * The web build has no native calendar, so the sheet offers only its preset
 * days there.
 */
export const CAN_PICK_DUE_DAY = false;

/** Nothing to draw on the web; `CAN_PICK_DUE_DAY` keeps the sheet from asking. */
export const DueDatePicker = (_props: DueDatePickerProps) => null;
