declare const items: unknown;
declare const tx: {
  select: () => {
    from: (table: unknown) => { for: (mode: string) => unknown };
  };
};
// Planted outside the aggregate owner; confine-aggregate-lock must report this acquisition.
// oxlint-disable-next-line confine-aggregate-lock/confine-aggregate-lock -- planted acquisition must be rejected
tx.select().from(items).for("update");
// expect-clean: confine-aggregate-lock/confine-aggregate-lock
tx.select().from(items);
