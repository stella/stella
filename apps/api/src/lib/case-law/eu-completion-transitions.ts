import {
  EU_COMPLETION_STATUSES,
  euCompletionApprovals,
  euCompletionControls,
  euCompletionReceipts,
} from "@/api/db/schema";
import {
  defineFixedLifecycle,
  defineLifecycle,
} from "@/api/lib/db/transitions";

// Active receipts settle to any outcome; dry-run settles only fetched work.
// Failed and mirror-repair receipts are readmitted; the rest are final.
const EU_COMPLETION_SETTLEMENTS = EU_COMPLETION_STATUSES.filter(
  (status): status is Exclude<typeof status, "dry-run"> => status !== "dry-run",
);
export const EU_COMPLETION_RECEIPT_LIFECYCLE = defineLifecycle({
  table: euCompletionReceipts,
  key: "id",
  graphs: {
    status: {
      edges: {
        pending: EU_COMPLETION_SETTLEMENTS,
        fetched: EU_COMPLETION_STATUSES,
        "failed-backoff": EU_COMPLETION_SETTLEMENTS,
        "publisher-refused": EU_COMPLETION_SETTLEMENTS,
        "superseded-by-crawl": EU_COMPLETION_SETTLEMENTS,
        failed: ["pending", "fetched", "withdrawn"],
        "review-required": ["pending", "fetched"],
        applied: [],
        unchanged: [],
        "dry-run": [],
        "too-large": [],
        "publisher-gone": [],
        withdrawn: [],
      },
      terminal: [
        "applied",
        "unchanged",
        "dry-run",
        "too-large",
        "publisher-gone",
        "withdrawn",
      ],
    },
    // The attempt lease is taken and released around every publisher read.
    attemptState: {
      edges: {
        idle: ["picked-up", "repair"],
        "picked-up": ["idle", "repair"],
        repair: ["idle", "picked-up"],
      },
      terminal: [],
    },
  },
});

export const EU_COMPLETION_CONTROL_LIFECYCLE = defineLifecycle({
  table: euCompletionControls,
  key: "key",
  graphs: { state: { edges: { off: ["on"], on: ["off"] }, terminal: [] } },
});

// The approval copies its dry-run receipt's outcome as foreign-key proof.
export const EU_COMPLETION_APPROVAL_PROOF = defineFixedLifecycle({
  table: euCompletionApprovals,
  column: "proofStatus",
  value: "dry-run",
});
