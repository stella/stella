// Passive regression fixture for the mutation's own filter chain.
export type Mutation = {
  where: (filter: unknown) => Mutation;
  returning: () => Mutation;
  set: (values: unknown) => Mutation;
};
declare const db: {
  delete: (table: unknown) => Mutation;
  update: (table: unknown) => Mutation;
};
declare const tx: typeof db;
declare const unrelated: { where: () => void };
declare const wrap: (mutation: Mutation) => Mutation;
declare const table: unknown;
declare const filter: unknown;
declare const values: unknown;

// oxlint-disable-next-line drizzle/enforce-delete-with-where -- fixture rejects an unfiltered delete
db.delete(table);
// oxlint-disable-next-line drizzle/enforce-update-with-where -- fixture rejects an unfiltered update
tx.update(table).set(values);

// expect-clean: drizzle/enforce-delete-with-where
db.delete(table).where(filter);
// expect-clean: drizzle/enforce-update-with-where
tx.update(table).set(values).where(filter);

unrelated.where();
// oxlint-disable-next-line drizzle/enforce-delete-with-where -- preceding unrelated where must not hide a delete
db.delete(table);
unrelated.where();
// oxlint-disable-next-line drizzle/enforce-update-with-where -- preceding unrelated where must not hide an update
db.update(table).set(values);

// oxlint-disable-next-line drizzle/enforce-delete-with-where -- enclosing where cannot filter the nested delete
wrap(db.delete(table)).where(filter);
// oxlint-disable-next-line drizzle/enforce-update-with-where -- enclosing where cannot filter the nested update
wrap(db.update(table).set(values)).where(filter);

// expect-clean: drizzle/enforce-delete-with-where
db.delete(table).where(filter).returning();
// expect-clean: drizzle/enforce-update-with-where
db.update(table).set(values).where(filter).returning();

// Direct parent updates must stay in the move owner.
declare const entities: unknown;
declare const parentId: string | null;
// oxlint-disable-next-line drizzle/no-direct-entity-reparent -- fixture rejects reparenting outside its serialized owner
tx.update(entities).set({ parentId }).where(filter);
// expect-clean: drizzle/no-direct-entity-reparent
tx.update(entities).set({ name: "Folder" }).where(filter);
