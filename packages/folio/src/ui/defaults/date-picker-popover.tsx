import type { FolioDatePickerPopoverProps } from "../folio-ui";

/**
 * Built-in, dependency-light DatePickerPopover used when a consumer does not
 * inject one. Renders a native `<input type="date">` whose value is an ISO
 * `yyyy-mm-dd` string; `onChange` emits that string (or `null` when cleared),
 * matching the design-system picker contract. Consumers inject a polished
 * calendar via `DocxEditor`'s `components` prop.
 */
const toISODate = (value: string | Date | null): string => {
  if (value === null) {
    return "";
  }
  if (value instanceof Date) {
    const year = value.getFullYear().toString().padStart(4, "0");
    const month = (value.getMonth() + 1).toString().padStart(2, "0");
    const day = value.getDate().toString().padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return value.length >= 10 ? value.slice(0, 10) : value;
};

export function DefaultDatePickerPopover({
  value,
  onChange,
  defaultOpen = false,
}: FolioDatePickerPopoverProps) {
  // The native date input is the intentional dependency-free fallback; a
  // consumer injects a locale-aware DatePickerPopover via DocxEditor.
  /* eslint-disable no-raw-date-input/no-raw-date-input -- intentional dependency-free fallback */
  return (
    <input
      autoFocus={defaultOpen}
      className="folio-default-date-input"
      onChange={(event) => onChange(event.target.value || null)}
      type="date"
      value={toISODate(value)}
    />
    /* eslint-enable no-raw-date-input/no-raw-date-input */
  );
}
