import { expect, test } from "bun:test";

import { readRegisteredMigrationAliasHistory } from "./migration-history";

test("migration alias inventory rejects unregistered index names", () => {
  for (const name of ["unregistered_index", "constructor", "__proto__"]) {
    expect(() =>
      readRegisteredMigrationAliasHistory([
        {
          fileName: "20261031000000_index_fixture",
          priorHash: "prior",
          newHash: "current",
          repair: {
            indexes: [
              {
                name,
                tableName: "records",
                definitionBody: "ON public.records USING btree (id)",
                isUnique: false,
              },
            ],
          },
        },
      ]),
    ).toThrow(`Unregistered migration alias index ${name}`);
  }
});
