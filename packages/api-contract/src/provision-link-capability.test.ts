import { expect, test } from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "./case-law-jurisdictions";
import {
  PROVISION_LINK_CAPABILITIES,
  provisionLinkCapability,
} from "./provision-link-capability";

test("every jurisdiction has an explicit capability", () => {
  expect(Object.keys(PROVISION_LINK_CAPABILITIES).toSorted()).toEqual(
    [...CASE_LAW_JURISDICTIONS].toSorted(),
  );
  for (const country of CASE_LAW_JURISDICTIONS) {
    const capability = PROVISION_LINK_CAPABILITIES[country];
    if (capability.type === "supported") {
      for (const language of capability.languages) {
        expect(provisionLinkCapability(country, language)).toEqual(capability);
      }
      expect(provisionLinkCapability(country, "zz")).toEqual({
        type: "notSupportedYet",
        reason: "language_not_supported",
      });
    } else {
      expect(provisionLinkCapability(country, "en")).toEqual(capability);
    }
  }
});

test("unknown jurisdiction has an explicit refusal", () => {
  expect(provisionLinkCapability("ZZZ", "zz")).toEqual({
    type: "notSupportedYet",
    reason: "unknown_jurisdiction",
  });
});
