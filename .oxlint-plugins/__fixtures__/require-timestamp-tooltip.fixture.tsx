// Passive regression fixture for `require-timestamp-tooltip`.

import { ListItem } from "@stll/ui/list";
import { TableCell } from "@stll/ui/table";

import { Timestamp } from "@/components/timestamp";
import Tooltip from "@/components/tooltip";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";

declare const formatter: { dateTime: (date: Date) => string };
declare const createdAt: Date;

export const _flagged = () => (
  <>
    <TableCell>
      {/* oxlint-disable-next-line require-timestamp-tooltip/require-timestamp-tooltip */}
      {formatter.dateTime(createdAt)}
    </TableCell>
    <ListItem>
      {/* oxlint-disable-next-line require-timestamp-tooltip/require-timestamp-tooltip */}
      {formatRelativeTime(createdAt)}
    </ListItem>
  </>
);

export const _allowed = () => (
  <>
    <TableCell>
      {/* expect-clean: require-timestamp-tooltip/require-timestamp-tooltip */}
      <Timestamp value={createdAt} />
    </TableCell>
    <TableCell>
      <Tooltip content={formatFullTimestamp(createdAt)} render={<span />}>
        {/* expect-clean: require-timestamp-tooltip/require-timestamp-tooltip */}
        {formatter.dateTime(createdAt)}
      </Tooltip>
    </TableCell>
  </>
);
