import { startKeyActionTimer } from "@/lib/analytics/key-action-timing";
import type { KeyActionTimer } from "@/lib/analytics/key-action-timing";
import { getAnalytics } from "@/lib/analytics/provider";
import type { Analytics, DocumentTimingSurface } from "@/lib/analytics/types";

// An open whose editor never becomes ready (a PDF, a closed tab, a tab that
// was already mounted) leaves its start behind; past this, a later ready
// signal for the same file belongs to another visit.
const DOCUMENT_OPEN_ABANDON_AFTER_MS = 60_000;

type PendingOpen = {
  requestedAt: number;
  surface: DocumentTimingSurface;
  timer: KeyActionTimer;
};

/**
 * Pairs the click that opens a file with its editor becoming ready. The open
 * starts in navigation code and ends inside the editor, which share only the
 * file's field id; the id stays in memory and never reaches the event.
 */
export const createDocumentOpenTiming = (
  analytics: () => Pick<Analytics, "captureKeyActionTiming">,
  now: () => number = () => performance.now(),
) => {
  const pending = new Map<string, PendingOpen>();
  return {
    requested: (fieldId: string, surface: DocumentTimingSurface) => {
      const requestedAt = now();
      // Starts no editor will finish would otherwise accumulate.
      for (const [id, open] of pending) {
        if (requestedAt - open.requestedAt > DOCUMENT_OPEN_ABANDON_AFTER_MS) {
          pending.delete(id);
        }
      }
      pending.get(fieldId)?.timer.cancel();
      pending.set(fieldId, {
        requestedAt,
        surface,
        timer: startKeyActionTimer(
          analytics(),
          { action: "document-open", surface },
          { abandonAfterMs: DOCUMENT_OPEN_ABANDON_AFTER_MS, now },
        ),
      });
    },
    editorReady: (fieldId: string, surface: DocumentTimingSurface) => {
      const open = pending.get(fieldId);
      if (open?.surface !== surface) {
        return;
      }
      pending.delete(fieldId);
      open.timer.finish();
    },
  };
};

export const documentOpenTiming = createDocumentOpenTiming(getAnalytics);
