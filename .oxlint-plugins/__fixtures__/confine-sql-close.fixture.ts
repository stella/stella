declare const client: {
  close: (options?: { timeout: number }) => Promise<void>;
};
declare const forceClosePool: (connection: typeof client) => Promise<void>;

// oxlint-disable-next-line confine-sql-close/confine-sql-close -- fixture: reserved and pool zero semantics require the owner
void client.close({ timeout: 0 });

// oxlint-disable-next-line confine-sql-close/confine-sql-close -- fixture: positive budgets also belong to the owner
void client.close({ timeout: 0.001 });

// oxlint-disable-next-line confine-sql-close/confine-sql-close -- fixture: scope timeout forwarding bypasses the owner
const rawScope = { closeTimeout: 0.001 };

// expect-clean: confine-sql-close/confine-sql-close
void forceClosePool(client);
void client.close();

export { rawScope };
