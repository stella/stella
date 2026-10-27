import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { invoices } from "@/api/db/schema";
import {
  invoiceInMatter,
  invoiceMatterShare,
  invoiceTouchesMatter,
  invoiceWithinMatterAllowlist,
} from "@/api/lib/billing/invoice-scope";
import { createSafeId } from "@/api/lib/branded-types";

const workspaceId = createSafeId<"workspace">();
const fragments = {
  invoiceTouchesMatter: invoiceTouchesMatter(invoices, workspaceId),
  invoiceInMatter: invoiceInMatter(invoices, workspaceId),
  invoiceWithinMatterAllowlist: invoiceWithinMatterAllowlist(invoices, [
    workspaceId,
  ]),
  invoiceMatterShare: invoiceMatterShare(invoices, workspaceId),
} satisfies Record<string, SQL>;

describe("invoice scope fragments", () => {
  // Drizzle renders bare column names in a single-table selection, where a
  // bare outer column inside a subquery binds to the inner table instead. A
  // fragment that renders alike in a filter and a selection stays correlated.
  test.each(Object.entries(fragments))(
    "%s renders the same correlated SQL in a selection as in a filter",
    (_name, fragment) => {
      const builder = new QueryBuilder();
      const filtered = builder
        .select({ id: invoices.id })
        .from(invoices)
        .where(fragment)
        .toSQL().sql;
      const whereText = filtered.slice(filtered.indexOf(" where ") + 7);
      expect(whereText).toContain('"invoices"."');

      const selected = builder
        .select({ value: fragment })
        .from(invoices)
        .toSQL().sql;
      expect(selected).toContain(whereText);
    },
  );
});
