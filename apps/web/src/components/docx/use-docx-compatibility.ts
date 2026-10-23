import { useCallback, useState } from "react";

import type { DocxCompatibility } from "@stll/folio-react";

import { useLatestCallback } from "@/hooks/use-latest-callback";

type UseDocxCompatibilityOptions = {
  /** The document the verdict belongs to; a verdict for another is stale. */
  editTargetKey: string;
  isPreviewPlaceholderData: boolean;
  onCompatibilityChange:
    | ((compatibility: DocxCompatibility) => void)
    | undefined;
};

/** Folio's verdict on whether it can safely rewrite the loaded document. */
export const useDocxCompatibility = ({
  editTargetKey,
  isPreviewPlaceholderData,
  onCompatibilityChange,
}: UseDocxCompatibilityOptions) => {
  const [compatibilityState, setCompatibilityState] = useState<{
    targetKey: string;
    value: DocxCompatibility | null;
  }>({ targetKey: editTargetKey, value: null });
  const compatibility =
    compatibilityState.targetKey === editTargetKey
      ? compatibilityState.value
      : null;

  const handleCompatibilityChange = useLatestCallback(
    (nextCompatibility: DocxCompatibility) => {
      if (isPreviewPlaceholderData) {
        return;
      }

      setCompatibilityState({
        targetKey: editTargetKey,
        value: nextCompatibility,
      });
      onCompatibilityChange?.(nextCompatibility);
    },
  );

  const resetCompatibility = useCallback(() => {
    setCompatibilityState({ targetKey: editTargetKey, value: null });
  }, [editTargetKey]);

  return { compatibility, handleCompatibilityChange, resetCompatibility };
};
