import { describe, expect, test } from "bun:test";

import {
  PROVISION_EXTRACTION_ADMISSION,
  PROVISION_EXTRACTION_ADMISSION_REVISION,
} from "./provision-extraction-admission";

/**
 * The scopes each admission revision admits. Changing the admission moves
 * the current revision's scopes: bump `PROVISION_EXTRACTION_ADMISSION_REVISION`
 * and add its entry. Never edit an existing entry; deployments have applied it.
 */
const ADMITTED_SCOPES_BY_REVISION = {
  1: ["CZE/cs"],
} as const satisfies Record<number, readonly string[]>;

describe("provision extraction admission", () => {
  test("the admitted scopes are pinned to the admission revision", () => {
    const scopes = Object.values(PROVISION_EXTRACTION_ADMISSION)
      .map(({ jurisdiction, language }) => `${jurisdiction}/${language}`)
      .toSorted();
    expect(scopes).toEqual([
      ...ADMITTED_SCOPES_BY_REVISION[PROVISION_EXTRACTION_ADMISSION_REVISION],
    ]);
  });
});
