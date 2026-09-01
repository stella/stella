import type { JSX } from "react";

import type { TableSchema } from "@stll/ui/data-table";

import {
  CaseNumberCell,
  CitedByCell,
  CountryPill,
  DecisionDateCell,
  DecisionLanguageCell,
  decisionYear,
  HeadnoteCell,
} from "@/features/case-law/components/decision-cells";
import type { Decision } from "@/features/case-law/components/decision-cells";
import type { TranslationKey } from "@/i18n/types";
import { normalizeCaseLawLanguageSegment } from "@/lib/case-law-route";

/**
 * The one column model for decision rows, wherever they are shown: the public
 * results table and a research table draw the same cells, so a row saved from
 * a search looks the same in the table it lands in.
 */
export const DECISION_COLUMN_IDS = [
  "caseNumber",
  "court",
  "country",
  "date",
  "type",
  "headnote",
  "citedBy",
  "language",
] as const;

export type DecisionColumnId = (typeof DECISION_COLUMN_IDS)[number];

/** Synchronous by type: a cell is an element or text, never a promise. */
export type DecisionColumnRender = (decision: Decision) => JSX.Element | string;

export const DECISION_COLUMN_LABEL_KEYS = {
  caseNumber: "caseLaw.columns.caseNumber",
  court: "common.court",
  country: "common.country",
  date: "common.date",
  type: "common.type",
  headnote: "caseLaw.columns.headnote",
  citedBy: "caseLaw.columns.citedBy",
  language: "common.language",
} as const satisfies Record<DecisionColumnId, TranslationKey>;

const contentColumn = {
  sort: false,
  hide: false,
  resize: true,
  pin: false,
} as const;

const hideableContentColumn = {
  sort: false,
  hide: true,
  resize: true,
  pin: false,
} as const;

const metadataColumn = {
  sort: false,
  hide: true,
  resize: true,
  pin: false,
} as const;

export const decisionTableSchema: TableSchema<DecisionColumnRender> = {
  defaultMinSize: 80,
  columns: [
    {
      id: "caseNumber",
      label: "",
      render: (decision) => <CaseNumberCell decision={decision} />,
      size: 320,
      capabilities: contentColumn,
      emphasis: "content",
    },
    {
      id: "court",
      label: "",
      render: (decision) => decision.court,
      size: 220,
      capabilities: metadataColumn,
      emphasis: "metadata",
    },
    {
      id: "country",
      label: "",
      render: (decision) => <CountryPill country={decision.country} />,
      size: 90,
      capabilities: metadataColumn,
      emphasis: "metadata",
    },
    {
      id: "date",
      label: "",
      render: (decision) => <DecisionDateCell decision={decision} />,
      size: 130,
      capabilities: metadataColumn,
      emphasis: "metadata",
    },
    {
      id: "type",
      label: "",
      render: (decision) => decision.decisionType ?? "—",
      size: 120,
      capabilities: metadataColumn,
      emphasis: "metadata",
    },
    {
      id: "headnote",
      label: "",
      render: (decision) => <HeadnoteCell decision={decision} />,
      size: 420,
      capabilities: hideableContentColumn,
      emphasis: "content",
    },
    {
      id: "citedBy",
      label: "",
      render: (decision) => <CitedByCell decision={decision} />,
      size: 96,
      capabilities: metadataColumn,
      emphasis: "metadata",
    },
    {
      id: "language",
      label: "",
      render: (decision) => <DecisionLanguageCell decision={decision} />,
      size: 120,
      capabilities: metadataColumn,
      emphasis: "metadata",
    },
  ],
};

/** What rows can be grouped by; every option is a column whose value is finite. */
export const DECISION_GROUP_BY_OPTIONS = [
  "none",
  "court",
  "country",
  "year",
  "type",
  "language",
] as const;

export type DecisionGroupBy = (typeof DECISION_GROUP_BY_OPTIONS)[number];

/**
 * The grouping key of a row, or null for an ungrouped table. Keys are raw
 * values (not labels) so the same decision groups the same way in every
 * locale; the caller labels them.
 */
export const decisionGroupKey = (
  groupBy: DecisionGroupBy,
  decision: Decision,
): string | null => {
  switch (groupBy) {
    case "none":
      return null;
    case "court":
      return decision.court;
    case "country":
      return decision.country;
    case "year": {
      const year = decisionYear(decision.decisionDate);
      return year === null ? "" : String(year);
    }
    case "type":
      return decision.decisionType ?? "";
    case "language":
      return normalizeCaseLawLanguageSegment(decision.language) ?? "";
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
};
