import { describe, expect, test } from "bun:test";

import { clientStatus } from "./native-client";

const RECORD = { fingerprint: "fp-1", binary: "binary-1" };

describe("development client status", () => {
  test("no installed client needs a build", () => {
    expect(clientStatus("fp-1", null, RECORD)).toBe("missing");
  });

  test("a client this helper never built is unknown, not compatible", () => {
    expect(clientStatus("fp-1", "binary-1", null)).toBe("unknown");
    // Reinstalled from elsewhere: the record vouches for another binary.
    expect(clientStatus("fp-1", "binary-2", RECORD)).toBe("unknown");
  });

  test("the recorded binary fits only the fingerprint it was built from", () => {
    expect(clientStatus("fp-1", "binary-1", RECORD)).toBe("compatible");
    expect(clientStatus("fp-2", "binary-1", RECORD)).toBe("stale");
  });
});
