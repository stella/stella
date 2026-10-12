import { useState } from "react";

import { QueryClientProvider } from "@tanstack/react-query";
import { Streamdown } from "streamdown";

import type { TableChartResponse } from "@stll/api-contract/table-chart";

import { ChatTableChart } from "@/components/chat/chat-table-chart";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { createAppQueryClient } from "@/lib/react-query";

const fixture = {
  status: "ready",
  plan: {
    kind: "bar",
    columns: [
      { index: 0, role: "label" },
      { index: 1, role: "y" },
    ],
    sort: "none",
    title: "Hours",
  },
} satisfies TableChartResponse;
const requestPlan = async () => await Promise.resolve(fixture);
const components = {
  a: StreamdownMentionLink,
  table: (
    props: Omit<React.ComponentProps<typeof ChatTableChart>, "cacheScope">,
  ) => (
    <ChatTableChart
      {...props}
      cacheScope={["fixture-org", "fixture-user"]}
      requestPlan={requestPlan}
    />
  ),
};

export const TableChartPlayground = () => {
  const [queryClient] = useState(createAppQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <section
        className="w-full max-w-2xl p-6"
        data-playground-section="table-chart"
      >
        <Streamdown mode="static" components={components}>
          {
            "| Month | Hours |\n| --- | ---: |\n| June | 12 |\n| July | 8 |\n| August | 16 |"
          }
        </Streamdown>
      </section>
    </QueryClientProvider>
  );
};
