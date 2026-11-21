import { useState } from "react";

import { QueryClientProvider } from "@tanstack/react-query";

import type { TableChartResponse } from "@stll/api-contract/table-chart";

import { MessageResponse } from "@/components/ai-elements/message";
import { ChatTableChart } from "@/components/chat/chat-table-chart";
import { createAppQueryClient } from "@/lib/react-query";

const fixture = {
  status: "ready",
  plan: {
    kind: "bar",
    columns: [
      { index: 0, role: "label" },
      { index: 1, role: "y" },
      { index: 2, role: "ignore" },
    ],
    sort: "none",
    title: "Hours billed",
  },
} satisfies TableChartResponse;
const requestPlan = async () => await Promise.resolve(fixture);
const components = {
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

const answer = [
  "The supply agreement has eight provisions worth negotiating before signature:",
  "",
  "| Provision | What it requires | Risk and recommended position |",
  "| --- | --- | --- |",
  "| Limitation of liability (clause 14.2) | Caps the supplier's total liability at the fees paid in the twelve months before the claim and excludes all indirect and consequential loss, including loss of profit and loss of data. | High. For a buyer whose operations depend on the deliveries, a twelve-month fee cap can be far below the real exposure. Ask for a cap of at least twice the annual fees and carve out data loss, breach of confidentiality and wilful misconduct. |",
  "| Termination for convenience (clause 18.1) | Lets either party end the agreement on 30 days' written notice without giving a reason. | Medium. Thirty days is short for finding a replacement supplier. Propose 90 days and an obligation to keep supplying at the agreed prices during the notice period. |",
  "| Governing law and jurisdiction (clause 22) | Puts the agreement under the law of the supplier's seat and gives its courts exclusive jurisdiction. | Medium. Litigating abroad raises costs. Seek the buyer's law or arbitration seated in a neutral place. |",
  "| Price adjustment (clause 7.4) | Allows the supplier to raise prices once a year by the change in the consumer price index plus two percentage points. | Low to medium. Accept the index but drop the extra two points, or cap any single increase at 5 %. |",
  "| Confidentiality (clause 16) | Binds both parties for two years after the agreement ends and excludes information that becomes public. | Medium. Two years is short for pricing and technical data. Ask for five years, and for trade secrets for as long as they stay secret. |",
  "| Warranty (clause 11.3) | Warrants the goods for six months from delivery; the only remedy is repair or replacement at the supplier's choice. | High. Latent defects often show later. Ask for twelve months from acceptance and a right to a price reduction or to terminate if repair fails twice. |",
  "| Assignment (clause 24.1) | Lets the supplier assign the agreement to any company in its group without consent. | Low. Accept group assignment if the assignee takes over all obligations and the supplier stays jointly liable. |",
  "| Force majeure (clause 19) | Suspends obligations for events beyond a party's control, with no time limit and no duty to mitigate. | Medium. Add a duty to mitigate and a right to terminate if the event lasts longer than 60 days. |",
  "",
  "Hours recorded on the matter so far:",
  "",
  "| Month | Hours billed | Hours written off |",
  "| --- | ---: | ---: |",
  "| June | 12 | 1.5 |",
  "| July | 8 | 0 |",
  "| August | 16 | 2 |",
  "| September | 21 | 3.5 |",
].join("\n");

export const TableChartPlayground = () => {
  const [queryClient] = useState(createAppQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <section
        className="w-full max-w-3xl p-4 text-sm leading-relaxed sm:p-6"
        data-playground-section="table-chart"
      >
        <MessageResponse components={components} mode="static">
          {answer}
        </MessageResponse>
      </section>
    </QueryClientProvider>
  );
};
