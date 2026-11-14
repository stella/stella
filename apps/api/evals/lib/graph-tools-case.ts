/**
 * The synthetic case the graph tools eval runs on: one matter with a witness
 * statement whose claims were verified against a list of facts, each fact
 * sourced from a document passage. Every name and event is invented.
 */

import type { ClaimRef } from "@/api/lib/lists/verification/contract";

type GraphCaseFact = {
  key: string;
  name: string;
  document: string;
  quote: string;
};

type GraphCaseClaim = {
  key: string;
  text: string;
  cites: readonly { fact: string; rel: ClaimRef["rel"] }[];
};

export const GRAPH_CASE = {
  statement: "Witness statement of the ship's master.docx",
  facts: [
    {
      key: "arrival",
      name: "The vessel arrived at the discharge port on 3 May",
      document: "Port arrival log.pdf",
      quote: "MV Larkspur berthed at quay 7 at 06:40 on 3 May.",
    },
    {
      key: "damage",
      name: "The cargo survey found water damage in hold 2",
      document: "Cargo survey report.pdf",
      quote: "Hold 2: seawater ingress, 41 pallets wet and unsaleable.",
    },
    {
      key: "payment",
      name: "The buyer paid the freight invoice on 20 May",
      document: "Bank statement May.pdf",
      quote: "20 May  Transfer to Harbourline Shipping  EUR 18,400.00",
    },
  ],
  claims: [
    {
      key: "arrived",
      text: "We arrived at the discharge port on the morning of 3 May.",
      cites: [{ fact: "arrival", rel: "supports" }],
    },
    {
      key: "undamaged",
      text: "The cargo was discharged in perfect condition.",
      cites: [{ fact: "damage", rel: "conflicts" }],
    },
    {
      key: "paid",
      text: "The freight was paid in full in May.",
      cites: [{ fact: "payment", rel: "supports" }],
    },
  ],
} as const satisfies {
  statement: string;
  facts: readonly GraphCaseFact[];
  claims: readonly GraphCaseClaim[];
};

export type GraphEvalTask = {
  id: string;
  prompt: string;
  /** Words the answer must contain: the exact text the graph holds. */
  expectedInAnswer: readonly string[];
  /** The edge filter a direct path to the answer uses, if one does. */
  expectedFilter: { stance?: ClaimRef["rel"]; edgeKind?: string } | null;
};

export const GRAPH_EVAL_TASKS: readonly GraphEvalTask[] = [
  {
    id: "en-conflict-quote",
    prompt:
      "In this matter, which part of the master's witness statement does the record contradict? Quote the exact passage of the document that contradicts it.",
    expectedInAnswer: ["41 pallets wet"],
    expectedFilter: { stance: "conflicts" },
  },
  {
    id: "cs-payment-source",
    prompt:
      "Z jakého dokumentu pochází skutečnost, že kupující zaplatil fakturu za přepravu? Uveď přesnou citaci.",
    expectedInAnswer: ["Bank statement May.pdf", "EUR 18,400.00"],
    expectedFilter: { edgeKind: "sourced-from" },
  },
  {
    id: "en-claim-to-documents",
    prompt:
      "Which documents does the master's claim about arriving on 3 May rest on? Name each document.",
    expectedInAnswer: ["Port arrival log.pdf"],
    expectedFilter: null,
  },
];
