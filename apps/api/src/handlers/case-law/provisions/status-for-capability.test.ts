import { expect, test } from "bun:test";

import { provisionLinkCapability } from "@stll/api-contract/provision-link-capability";
import { PROVISION_LINK_STATUS_TYPES } from "@stll/api-contract/provision-link-status";

import { provisionStatusForCapability } from "./status-for-capability";

test.each([
  ["USA", "en"],
  ["CZE", "en"],
  ["SVK", "cs"],
])(
  "unsupported reader %s/%s never implies future work",
  (country, language) => {
    const capability = provisionLinkCapability(country, language);
    expect(capability.type).toBe("notSupportedYet");
    for (const type of PROVISION_LINK_STATUS_TYPES) {
      expect(provisionStatusForCapability(capability, { type })).toEqual({
        type: "out_of_scope",
      });
    }
  },
);

test.each(PROVISION_LINK_STATUS_TYPES)(
  "supported reader preserves %s",
  (type) => {
    const status = { type };
    expect(
      provisionStatusForCapability(
        provisionLinkCapability("CZE", "cs"),
        status,
      ),
    ).toBe(status);
  },
);
