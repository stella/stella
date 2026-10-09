import { expect, test } from "bun:test";

import {
  dockerContainerName,
  dockerImageRef,
  dockerVolumeName,
} from "./docker-volume-name";

const invalidNames = ["", "-a", "a b", "a,b", "a=b", "/a"];

const validVolumeNames = ["data", "corpus-suite-1-0-data", "a.b_c-d", "0abc"];

test("dockerVolumeName accepts Docker volume names", () => {
  const accepted: string[] = validVolumeNames.map((name) =>
    dockerVolumeName(name),
  );
  expect(accepted).toEqual(validVolumeNames);
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
  const accepted: string[] = [
    dockerContainerName("corpus-suite-1-0"),
    dockerImageRef("sha256:abc123"),
    dockerImageRef("registry.example/app/img:1.0"),
  ];
  expect(accepted).toEqual([
    "corpus-suite-1-0",
    "sha256:abc123",
    "registry.example/app/img:1.0",
  ]);
});
