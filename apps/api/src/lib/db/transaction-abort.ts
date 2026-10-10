/** Reject a transaction callback so its writes roll back, preserving the refusal. */
export function abortTransaction(error: unknown): never {
  throw error;
}
