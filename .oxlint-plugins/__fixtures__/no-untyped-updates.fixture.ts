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

type BroadUpdateAlias = Record<string, unknown>;

export const aliasedTypeUpdate = () => {
  const updates: BroadUpdateAlias = { title: "Matter" };
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: a local type alias must not hide a broad update bag
  return db.update(table).set(updates);
};

export const parameterUpdate = (updates: Record<string, unknown>) =>
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: a parameter annotation must retain broad update-bag provenance
  db.update(table).set(updates);

type DestructuredUpdateArgs = {
  metadata: string;
  updates: BroadUpdateAlias;
};

export const destructuredParameterUpdate = ({
  updates,
}: DestructuredUpdateArgs) =>
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: destructuring a broad parameter property must retain its annotated provenance
  db.update(table).set(updates);

// Allowed: broad records used as metadata never reach a Drizzle update sink.
export const metadata: Record<string, unknown> = { source: "court" };

// Allowed: a Map set call is not a Drizzle update sink.
export const cacheMetadata = () =>
  new Map<string, unknown>().set("metadata", metadata);

type MatterUpdate = Partial<{ title: string; status: string }>;
const typedUpdate: MatterUpdate = { title: "Matter" };

export const destructuredTypedParameterUpdate = ({
  updates,
}: {
  updates: MatterUpdate;
}) => db.update(table).set(updates);

// Allowed: the update bag retains its schema-derived field set.
export const updateMatter = () => db.update(table).set(typedUpdate);
