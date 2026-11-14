import type { ComponentProps } from "react";

import { BulkAddColumns } from "@/components/workspaces/bulk-add-columns";

const TARGET = {
  kind: "organisation",
  mode: { type: "add" },
  suggestion: {
    country: "CZ",
    query: undefined,
    filters: {
      court: undefined,
      decisionType: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      language: undefined,
    },
    decisionIds: [],
  },
} satisfies ComponentProps<typeof BulkAddColumns>["target"];

export const ColumnComposerPlayground = () => (
  <div className="p-4" data-playground-section="column-composer">
    <BulkAddColumns target={TARGET} triggerVariant="labelled" />
  </div>
);
