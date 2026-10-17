import { holdInspectorRestoreSettle } from "@/components/inspector/inspector-broadcast";
import { useExternalSyncEffect } from "@/hooks/use-effect";

/**
 * Keeps a restored inspector from counting as settled while this viewer is
 * still loading its document. Renders nothing.
 */
export const InspectorRestoreHold = ({ ready }: { ready: boolean }) => {
  useExternalSyncEffect(
    () => (ready ? undefined : holdInspectorRestoreSettle()),
    [ready],
  );
  return null;
};
