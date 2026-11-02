import { DOCUMENT_DERIVATIVE_RUN_OWNERSHIP_REPAIRS } from "../document-derivative-run-ownership-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-document-derivative-run-ownership-repairs",
  revision: 1183,
  type: "repairs",
  values: [...DOCUMENT_DERIVATIVE_RUN_OWNERSHIP_REPAIRS],
} satisfies OnlineMigrationEntry;
