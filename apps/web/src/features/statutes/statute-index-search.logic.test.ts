import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";

import {
  changeStatutesIndexQuery,
  readStatuteIntent,
  statutesIndexSearchSchema,
} from "@/features/statutes/statute-index-search.logic";

describe("statute search mode transitions", () => {
  for (const country of ["cze", "svk"]) {
    for (const validity of LEGISLATION_LIST_VALIDITIES) {
      test(`${country} drops ${validity} in full-text and leaves it cleared on returning to the list`, () => {
        const previous = v.parse(statutesIndexSearchSchema, {
          page: 3,
          pageSize: 25,
          q: "89/2012",
          type: "statute",
          validity,
        });
        expect(readStatuteIntent(country, previous.q).type).toBe("act");
        const fullText = changeStatutesIndexQuery({
          country,
          previous,
          query: "  contractual obligations  ",
        });
        expect(readStatuteIntent(country, fullText.q).type).toBe("text");
        expect(fullText).toEqual({
          page: undefined,
          pageSize: 25,
          q: "contractual obligations",
          type: "statute",
          validity: undefined,
        });
        for (const query of ["89/2012", ""]) {
          const list = changeStatutesIndexQuery({
            country,
            previous: fullText,
            query,
          });
          expect(readStatuteIntent(country, list.q).type).toBe(
            query ? "act" : "empty",
          );
          expect(list.validity).toBeUndefined();
          expect(list.type).toBe("statute");
          expect(list.page).toBeUndefined();
        }
      });

      test(`${country} keeps ${validity} between list queries`, () => {
        const previous = v.parse(statutesIndexSearchSchema, {
          q: "89/2012",
          validity,
        });
        for (const query of ["40/1964", ""]) {
          const next = changeStatutesIndexQuery({ country, previous, query });
          expect(next.validity).toBe(validity);
          expect(next.page).toBeUndefined();
        }
      });
    }
  }
});
