import { AsyncLocalStorage } from "node:async_hooks";

import type { Transaction } from "@/api/db/root";

const creationTransaction = new AsyncLocalStorage<Transaction>();

/** Lifecycle hooks share the owner transaction that inserts the organization. */
export const currentOrganizationCreationTransaction = () =>
  creationTransaction.getStore();

export const withOrganizationCreationTransaction = async <T>(
  tx: Transaction,
  run: () => Promise<T>,
) => await creationTransaction.run(tx, run);
