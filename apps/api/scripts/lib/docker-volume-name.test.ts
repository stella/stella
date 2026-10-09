import { expect, test } from "bun:test";

import {
  dockerContainerName,
  dockerImageRef,
  dockerVolumeName,
} from "./docker-volume-name";

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

test("dockerContainerName shares the name validation", () => {
  expect(dockerContainerName("corpus-suite-1-0")).toBe("corpus-suite-1-0");
  expect(() => dockerContainerName("a,b")).toThrow(
    "Invalid Docker container name",
  );
});

test("dockerImageRef accepts references and rejects option-like values", () => {
  expect(dockerImageRef("sha256:abc123")).toBe("sha256:abc123");
  expect(dockerImageRef("registry.example/app/img:1.0")).toBe(
    "registry.example/app/img:1.0",
  );
  expect(() => dockerImageRef("--privileged")).toThrow(
    "Invalid Docker image reference",
  );
});
