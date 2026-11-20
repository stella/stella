import { DOCUMENT_DERIVATIVE_RUN_OWNERSHIP_CONSTRAINTS } from "../document-derivative-run-ownership-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-document-derivative-run-ownership-constraints",
  revision: 1393,
  lifecycle: "pending",
  type: "constraints",
  values: [...DOCUMENT_DERIVATIVE_RUN_OWNERSHIP_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
