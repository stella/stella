declare const items: unknown;
declare const tx: {
  select: () => {
    from: (table: unknown) => { for: (mode: string) => unknown };
  };
};
// Planted outside the aggregate owner; confine-aggregate-lock must report this acquisition.
tx.select().from(items).for("update");
