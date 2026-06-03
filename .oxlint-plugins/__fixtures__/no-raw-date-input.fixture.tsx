// Passive regression fixture for `no-raw-date-input/no-raw-date-input`.
//
// `oxlint-disable-next-line` directives below intentionally suppress cases
// the rule MUST flag. If the rule regresses, the disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.
//
// Lines without a disable directive must continue to pass — they cover
// the allow-list (non-date input types, DatePickerPopover usage, etc.).

import { Input } from "@stll/ui/components/input";

const _nativeDate = () => (
  // oxlint-disable-next-line no-raw-date-input/no-raw-date-input
  <input name="dob" type="date" />
);

const _nativeDatetime = () => (
  // oxlint-disable-next-line no-raw-date-input/no-raw-date-input
  <input name="start" type="datetime-local" />
);

const _stllInputDate = () => (
  // oxlint-disable-next-line no-raw-date-input/no-raw-date-input
  <Input name="from" type="date" />
);

const _stllInputMonth = () => (
  // oxlint-disable-next-line no-raw-date-input/no-raw-date-input
  <Input name="month" type="month" />
);

// --- Cases that MUST NOT flag (no disable directives below) ---

const _nativeText = () => <input name="q" type="text" />;
const _nativeNumber = () => <input name="n" type="number" />;
const _stllInputText = () => <Input name="search" type="search" />;

// A bespoke component named DatePickerPopover should not be flagged
// even if it accepted a `type` attribute, because the rule scope is
// limited to native `<input>` / `<Input>` wrappers.
const _customComponent = () => <Custom type="date" />;
const Custom = (_props: { type: string }) => null;

export const __noRawDateInputFixture = {
  _nativeDate,
  _nativeDatetime,
  _stllInputDate,
  _stllInputMonth,
  _nativeText,
  _nativeNumber,
  _stllInputText,
  _customComponent,
};
