import { lazy, Suspense } from "react";

import { defaultComponents } from "streamdown";

import type { ChatTableChartProps } from "@/components/chat/chat-table-chart";

const TableChart = lazy(async () => {
  const { ChatTableChart } = await import("@/components/chat/chat-table-chart");
  return { default: ChatTableChart };
});

// While the chart chunk loads, the table renders as the markdown renderer
// draws it, the same element `ChatTableChart` shows as its source table, so
// the answer does not reflow when the chunk arrives.
const SourceTable = defaultComponents.table;

export const LazyChatTableChart = ({
  node,
  cacheScope,
  ...props
}: ChatTableChartProps) => (
  <Suspense fallback={<SourceTable {...props} />}>
    <TableChart node={node} cacheScope={cacheScope} {...props} />
  </Suspense>
);
