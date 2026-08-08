// Importing the duplicate formatters must be rejected.
// oxlint-disable-next-line require-relative-time-helpers/require-relative-time-helpers
import { formatRelativeTime as duplicateRelativeTime } from "@/components/workspaces/entity-utils";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";

declare const date: Date;

// Rebuilding the canonical full formatter must be rejected.
// oxlint-disable-next-line require-relative-time-helpers/require-relative-time-helpers
const _inline = date.toLocaleString("en", {
  dateStyle: "full",
  timeStyle: "medium",
});

// Native title is not the shared timestamp tooltip.
// oxlint-disable-next-line require-relative-time-helpers/require-relative-time-helpers
const _title = <span title={formatFullTimestamp(date)}>time</span>;

// Canonical helpers, shared tooltip content, and date-only formatting stay valid.
const _relative = formatRelativeTime(date);
const _tooltip = <Tooltip content={formatFullTimestamp(date)} />;
const _tooltipOwner = (
  <ReadOnlyRow title={formatFullTimestamp(date)}>time</ReadOnlyRow>
);
const _dateOnly = date.toLocaleString("en", { dateStyle: "full" });

declare const Tooltip: (props: { content: string }) => unknown;
declare const ReadOnlyRow: (props: {
  children: string;
  title: string;
}) => unknown;

export const __requireRelativeTimeHelpersFixture = {
  duplicateRelativeTime,
  _inline,
  _title,
  _relative,
  _tooltip,
  _tooltipOwner,
  _dateOnly,
};
