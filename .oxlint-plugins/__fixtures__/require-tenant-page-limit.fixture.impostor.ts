// An anonymous factory's name imported from a module that does not define it
// does not exempt the file from the tenant page budget.
import { createSafePublicHandler } from "@/api/lib/unrelated-module";

declare const query: { limit?: number };

export const impostorPage = () => {
  // oxlint-disable-next-line require-tenant-page-limit/require-tenant-page-limit -- an impostor factory import keeps the page budget
  const limit = query.limit ?? 50;
  return { limit, createSafePublicHandler };
};
