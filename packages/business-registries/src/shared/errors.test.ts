import { describe, expect, test } from "bun:test";

import { AresError, AresNotFoundError } from "../ares/index.js";
import { BrregError, BrregNotFoundError } from "../brreg/index.js";
import { isEntityNotFound, RegistryError } from "./errors.js";

describe("EntityNotFound contract", () => {
  test("AresNotFoundError still passes `instanceof AresError`", () => {
    const error = new AresNotFoundError("27082440");
    expect(error).toBeInstanceOf(AresError);
    expect(error).toBeInstanceOf(RegistryError);
  });

  test("BrregNotFoundError still passes `instanceof BrregError`", () => {
    const error = new BrregNotFoundError("974760673");
    expect(error).toBeInstanceOf(BrregError);
    expect(error).toBeInstanceOf(RegistryError);
  });

  test("isEntityNotFound recognises both adapter NotFound classes", () => {
    expect(isEntityNotFound(new AresNotFoundError("27082440"))).toBe(true);
    expect(isEntityNotFound(new BrregNotFoundError("974760673"))).toBe(true);
  });

  test("isEntityNotFound rejects other RegistryError subclasses and non-errors", () => {
    expect(isEntityNotFound(new AresError("generic ARES failure"))).toBe(false);
    expect(isEntityNotFound(new Error("not even a RegistryError"))).toBe(false);
    expect(isEntityNotFound("string")).toBe(false);
    expect(isEntityNotFound(null)).toBe(false);
    expect(isEntityNotFound(undefined)).toBe(false);
  });

  test("isEntityNotFound surfaces canonicalId + registrySlug for downstream use", () => {
    const ares = new AresNotFoundError("27082440");
    expect(isEntityNotFound(ares)).toBe(true);
    if (isEntityNotFound(ares)) {
      expect(ares.canonicalId).toBe("27082440");
      expect(ares.registrySlug).toBe("cz-ares");
    }

    const brreg = new BrregNotFoundError("974760673");
    expect(isEntityNotFound(brreg)).toBe(true);
    if (isEntityNotFound(brreg)) {
      expect(brreg.canonicalId).toBe("974760673");
      expect(brreg.registrySlug).toBe("no-brreg");
    }
  });
});
