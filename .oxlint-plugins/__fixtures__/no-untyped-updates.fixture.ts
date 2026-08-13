// Passive regression fixture for no-untyped-updates.

declare const table: unknown;
declare const db: {
  update: (target: unknown) => {
    set: (value: unknown) => unknown;
  };
};

export const untypedUpdate = () => {
  const updates: Record<string, unknown> = { title: "Matter" };
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: broad records at Drizzle update sinks bypass column checking
  return db.update(table).set(updates);
};

export const aliasedAnyUpdate = () => {
  // oxlint-disable-next-line typescript/no-explicit-any -- fixture: the custom rule must recognize any-valued update bags
  const updates: Record<string, any> = { title: "Matter" };
  const alias = updates;
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: a stable alias must not launder a broad update bag
  return db.update(table).set(alias);
};

export const spreadUnknownUpdate = () => {
  const updates: Record<string, unknown> = { title: "Matter" };
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: spreading a broad update bag into the sink remains unsafe
  return db.update(table).set({ ...updates, updatedAt: new Date(0) });
};

// Allowed: broad records used as metadata never reach a Drizzle update sink.
export const metadata: Record<string, unknown> = { source: "court" };

// Allowed: a Map set call is not a Drizzle update sink.
export const cacheMetadata = () =>
  new Map<string, unknown>().set("metadata", metadata);

type MatterUpdate = Partial<{ title: string; status: string }>;
const typedUpdate: MatterUpdate = { title: "Matter" };

// Allowed: the update bag retains its schema-derived field set.
export const updateMatter = () => db.update(table).set(typedUpdate);
