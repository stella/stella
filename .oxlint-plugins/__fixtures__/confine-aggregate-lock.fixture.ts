declare const items: unknown;
declare const tx: {
  execute: (statement: string) => unknown;
  select: () => {
    from: (table: unknown) => { for: (mode: string) => unknown };
  };
};
// Planted outside the aggregate owner; confine-aggregate-lock must report this acquisition.
// oxlint-disable-next-line confine-aggregate-lock/confine-aggregate-lock -- planted acquisition must be rejected
tx.select().from(items).for("update");
// expect-clean: confine-aggregate-lock/confine-aggregate-lock
tx.select().from(items);

// oxlint-disable-next-line confine-aggregate-lock/confine-aggregate-lock -- planted shared acquisition must be rejected
tx.execute("SELECT pg_advisory_xact_lock_shared(1, 2)");
// oxlint-disable-next-line confine-aggregate-lock/confine-aggregate-lock -- planted shared NOWAIT acquisition must be rejected
tx.execute("SELECT pg_try_advisory_xact_lock_shared(1, 2)");
