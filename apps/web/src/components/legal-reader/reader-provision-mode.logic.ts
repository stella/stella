import { Result } from "better-result";
import * as v from "valibot";

export { READER_PROVISION_MODE_STORAGE_KEY } from "@/lib/account/storage-keys";
export const READER_PROVISION_MODE = {
  collapsed: "collapsed",
  expanded: "expanded",
} as const;

export type ReaderProvisionMode = keyof typeof READER_PROVISION_MODE;

const StoredReaderProvisionModeSchema = v.picklist(
  Object.values(READER_PROVISION_MODE),
);

export const parseReaderProvisionMode = (raw: string | null) => {
  const value = Result.try(() => JSON.parse(raw ?? "null") as unknown).unwrapOr(
    null,
  );
  const parsed = v.safeParse(StoredReaderProvisionModeSchema, value);
  return parsed.success ? parsed.output : READER_PROVISION_MODE.collapsed;
};
