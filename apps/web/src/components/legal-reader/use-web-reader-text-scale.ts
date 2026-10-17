import * as v from "valibot";

import { READER_TEXT_SCALE_STORAGE_KEY } from "@stll/decision-reader/reader-text-scale.logic";
import { useReaderTextScale } from "@stll/decision-reader/use-reader-text-scale";

import { useLocalStorage } from "@/hooks/use-local-storage";
import { useAnalytics } from "@/lib/analytics/provider";
import {
  definePersistedState,
  keepInAnyScope,
} from "@/lib/persisted-state/registry";

const readerTextScaleEntry = definePersistedState({
  key: READER_TEXT_SCALE_STORAGE_KEY,
  area: "local",
  version: 1,
  schema: v.nullable(v.string()),
  maxBytes: 128,
  defaultValue: () => null,
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

export const useWebReaderTextScale = () => {
  const storage = useLocalStorage(readerTextScaleEntry, {});
  const analytics = useAnalytics();
  return useReaderTextScale({ storage, analytics });
};
