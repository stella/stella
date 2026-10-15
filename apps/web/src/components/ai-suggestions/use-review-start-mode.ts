import {
  parseReviewStartMode,
  reviewStartModeStorageKey,
} from "@/components/ai-suggestions/document-review-basis.logic";
import type { ReviewStartMode } from "@/components/ai-suggestions/document-review-basis.logic";
import { useUserStorageState } from "@/lib/account/use-user-storage-state";

const encodeMode = (mode: ReviewStartMode) => mode;

export const useReviewStartMode = (entityId: string, fileFieldId: string) => {
  const { value: mode, setValue: setMode } = useUserStorageState({
    baseKey: reviewStartModeStorageKey(entityId, fileFieldId),
    area: "local",
    decode: parseReviewStartMode,
    encode: encodeMode,
  });
  return { mode, setMode };
};
