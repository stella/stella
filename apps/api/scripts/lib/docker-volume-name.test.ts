import { expect, test } from "bun:test";

import { dockerVolumeName } from "./docker-volume-name";

test("dockerVolumeName accepts Docker volume names", () => {
  for (const name of ["data", "corpus-suite-1-0-data", "a.b_c-d", "0abc"]) {
    expect(dockerVolumeName(name)).toBe(name);
  }
});

test("dockerVolumeName rejects names that carry mount option syntax", () => {
  for (const name of [
    "",
    "-data",
    "data,volume-opt=device=/host",
    "a=b",
    "a b",
    "/host",
  ]) {
    expect(() => dockerVolumeName(name)).toThrow("Invalid Docker volume name");
  }
});
