import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

// oxlint-disable-next-line no-raw-property-assert/no-raw-property-assert -- fixture: raw execution belongs to the shared runner
fc.assert(fc.property(fc.string(), () => true));

// expect-clean: no-raw-property-assert/no-raw-property-assert
assertProperty("strings retain their type", fc.property(fc.string(), (value) => typeof value === "string"));
