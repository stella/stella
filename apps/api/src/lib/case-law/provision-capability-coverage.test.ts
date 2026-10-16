import { expect, test } from "bun:test";

import {
  ADAPTER_MANIFESTS,
  IMPORT_SOURCE_MANIFESTS,
} from "@/api/lib/legal-search/adapter-manifest";

import { checkProvisionCapabilityCoverage } from "./provision-capability-coverage";

test("all crawl and import jurisdictions have a capability", () => {
  expect(() =>
    checkProvisionCapabilityCoverage([
      ...Object.values(ADAPTER_MANIFESTS),
      ...Object.values(IMPORT_SOURCE_MANIFESTS),
    ]),
  ).not.toThrow();
});

test.each(["crawl", "import"])("missing %s jurisdiction fails closed", () => {
  expect(() =>
    checkProvisionCapabilityCoverage([{ country: "ZZZ", language: "zz" }]),
  ).toThrow("Missing provision capability for ZZZ");
});

test("missing import-only disposition fails closed", () => {
  expect(() =>
    checkProvisionCapabilityCoverage(
      Object.values(IMPORT_SOURCE_MANIFESTS),
      {},
    ),
  ).toThrow("Missing provision capability for USA");
});

test("supported jurisdiction with uncovered language fails closed", () => {
  expect(() =>
    checkProvisionCapabilityCoverage([{ country: "CZE", language: "en" }]),
  ).toThrow("Missing provision language capability for CZE/en");
});
