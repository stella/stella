import { lazy, Suspense } from "react";

import { AnswerTable } from "@/components/ai-elements/answer-table";
import type { ChatTableChartProps } from "@/components/chat/chat-table-chart";

const TableChart = lazy(async () => {
  const { ChatTableChart } = await import("@/components/chat/chat-table-chart");
  return { default: ChatTableChart };
});

// While the chart chunk loads, the table renders in the same answer table
// shell `ChatTableChart` draws, so the answer does not reflow when the chunk
// arrives.
export const LazyChatTableChart = (props: ChatTableChartProps) => {
  const {
    cacheScope: _cacheScope,
    requestPlan: _requestPlan,
    ...table
  } = props;
  return (
    <Suspense fallback={<AnswerTable {...table} />}>
      <TableChart {...props} />
    </Suspense>
  );
};
