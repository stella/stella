import { expect, test } from "bun:test";

import {
  dockerContainerName,
  dockerImageRef,
  dockerVolumeName,
} from "./docker-volume-name";

const invalidNames = ["", "-a", "a b", "a,b", "a=b", "/a"];

test("dockerVolumeName accepts Docker volume names", () => {
  for (const name of ["data", "corpus-suite-1-0-data", "a.b_c-d", "0abc"]) {
    expect(dockerVolumeName(name)).toBe(name);
  }
});

test("name helpers reject invalid names", () => {
  for (const name of invalidNames) {
    expect(() => dockerVolumeName(name)).toThrow("Invalid Docker volume name");
    expect(() => dockerContainerName(name)).toThrow(
      "Invalid Docker container name",
    );
    expect(() => dockerImageRef(name)).toThrow(
      "Invalid Docker image reference",
    );
  }
});

test("dockerContainerName and dockerImageRef accept valid values", () => {
  expect(dockerContainerName("corpus-suite-1-0")).toBe("corpus-suite-1-0");
  expect(dockerImageRef("sha256:abc123")).toBe("sha256:abc123");
  expect(dockerImageRef("registry.example/app/img:1.0")).toBe(
    "registry.example/app/img:1.0",
  );
});
