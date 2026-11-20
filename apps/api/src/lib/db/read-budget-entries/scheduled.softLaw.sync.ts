import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 100 },
  writes: {
    pagesPerWrittenRow: 12,
    ceilingPagesPerRun: 2000,
    reason:
      "One 25-document batch wrote 129 rows in 1,169 and 1,177 pages (about nine pages per row) across the document, version, locator and attempt tables with their indexes.",
  },
  reason:
    "One 25-document ingestion batch read 38 and 45 pages beside 1,000 and 10,000 rows of another source's history, so reads stay on the source's own index paths.",
} as const satisfies ReadBudget;
