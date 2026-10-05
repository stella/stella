import * as v from "valibot";

import { readStoredJson } from "@/lib/stored-json";

export const READER_PROVISION_MODE_STORAGE_KEY = "reader_provision_mode";
export const READER_PROVISION_MODE = {
  collapsed: "collapsed",
  expanded: "expanded",
} as const;

export type ReaderProvisionMode = keyof typeof READER_PROVISION_MODE;

const StoredReaderProvisionModeSchema = v.picklist(
  Object.values(READER_PROVISION_MODE),
);

export const parseReaderProvisionMode = (raw: string | null) =>
  readStoredJson(raw, StoredReaderProvisionModeSchema) ??
  READER_PROVISION_MODE.collapsed;
