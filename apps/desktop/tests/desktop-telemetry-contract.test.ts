import { describe, expect, test } from "bun:test";

import contract from "../fixtures/desktop-telemetry-contract.json" with { type: "json" };
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
} from "../src/telemetry/desktop-telemetry";

describe("desktop telemetry contract", () => {
  test("lists every value sent from the frontend", () => {
    expect(contract.windows).toEqual(Object.values(DESKTOP_TELEMETRY_WINDOWS));
    expect(contract.operations).toEqual(
      Object.values(DESKTOP_TELEMETRY_OPERATIONS),
    );
    expect(contract.errorCodes).toEqual(
      Object.values(DESKTOP_TELEMETRY_ERROR_CODES),
    );
  });
});
