import { lazy, Suspense } from "react";

import type { ChatTableChartProps } from "@/components/chat/chat-table-chart";

const TableChart = lazy(async () => {
  const { ChatTableChart } = await import("@/components/chat/chat-table-chart");
  return { default: ChatTableChart };
});

export const LazyChatTableChart = ({
  node,
  cacheScope,
  ...props
}: ChatTableChartProps) => (
  <Suspense fallback={<table {...props} />}>
    <TableChart node={node} cacheScope={cacheScope} {...props} />
  </Suspense>
);
