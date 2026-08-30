const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const isOutlookSourceId = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

type EnsureOutlookSourceIdOptions = {
  createId?: () => string;
  existing: unknown;
  mode: "browser" | "compose" | "read";
  persistItem: () => Promise<void>;
  persistProperty: (sourceId: string) => Promise<void>;
};

export const ensureOutlookSourceId = async ({
  createId = () => crypto.randomUUID(),
  existing,
  mode,
  persistItem,
  persistProperty,
}: EnsureOutlookSourceIdOptions): Promise<string> => {
  if (isOutlookSourceId(existing)) {
    return existing;
  }

  const sourceId = createId();
  await persistProperty(sourceId);
  if (mode === "compose") {
    await persistItem();
  }
  return sourceId;
};
