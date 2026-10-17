export const RAW_SOURCE_FAMILY = {
  CASE_LAW: "case-law",
  SOFT_LAW: "soft-law",
  LEGISLATION: "legislation",
} as const;

type RawSourcePrefixOptions = {
  family:
    | typeof RAW_SOURCE_FAMILY.SOFT_LAW
    | typeof RAW_SOURCE_FAMILY.LEGISLATION;
  sourceId: string;
};

/** Content-addressed payloads shared by a source, outside per-decision storage. */
export const rawSourcePrefix = ({
  family,
  sourceId,
}: RawSourcePrefixOptions): string => `${family}/raw/${sourceId}/`;
