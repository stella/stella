// Passive regression fixture for no-hand-built-date-range-filter.

import { DatePickerPopover as Calendar } from "@stll/ui/date-picker-popover";

export const PairedFilter = () => (
  <div>
    <div>
      From
      <Calendar />
    </div>
    <div>
      <span>To</span>
      {/* oxlint-disable-next-line no-hand-built-date-range-filter/no-hand-built-date-range-filter -- fixture: paired date pickers bypass the shared range filter */}
      <Calendar />
    </div>
  </div>
);

// expect-clean: no-hand-built-date-range-filter/no-hand-built-date-range-filter
export const SingleDate = () => (
  <div>
    From
    <Calendar />
  </div>
);
