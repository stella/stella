import * as v from "valibot";

import { useUserStorageState } from "@/lib/account/use-user-storage-state";
import { readStoredJson, serializeStoredJson } from "@/lib/stored-json";

const MIN_COL_WIDTH_PX = 80;
const MAX_COL_WIDTH_PX = 800;
const ColumnWidthsRecordSchema = v.record(v.string(), v.unknown());

const decodeWidths = (raw: string | null) => {
  const parsed = readStoredJson(raw, ColumnWidthsRecordSchema);
  const widths = new Map<string, number>();
  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      widths.set(key, value);
    }
  }
  return Object.fromEntries(widths);
};

export const useColumnWidths = (baseKey: string) => {
  const { value: widths, updateValue } = useUserStorageState({
    baseKey,
    area: "local",
    decode: decodeWidths,
    encode: serializeStoredJson,
  });
  const setWidth = (id: string, width: number) => {
    const clamped = Math.max(
      MIN_COL_WIDTH_PX,
      Math.min(MAX_COL_WIDTH_PX, Math.round(width)),
    );
    updateValue((previous) =>
      previous[id] === clamped ? previous : { ...previous, [id]: clamped },
    );
  };
  return { widths, setWidth };
};
