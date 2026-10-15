import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects owner accessor aliases namespaces and local file handles", async () => {
  expect(
    await lintSingleRule(
      "no-native-s3-object-read",
      'import { getS3 as storage } from "@/api/lib/s3";\nimport * as owner from "@/api/lib/s3";\nconst handle = storage().file(key);\nhandle.arrayBuffer();\nowner.getCorpusS3().file(key).text();\nhandle.bytes();\nhandle.json();',
      {
        plugin: "s3-object-boundary",
        sourcePath: "apps/api/src/handlers/files/read.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([4, 5, 6, 7]);
});

test("rejects native Bun default clients and imported constructors", async () => {
  expect(
    await lintSingleRule(
      "no-native-s3-object-read",
      'import { S3Client as Client, s3 as defaultClient } from "bun";\nnew Client(options).file(key).text();\ndefaultClient.file(key).arrayBuffer();\nBun.s3.file(key).bytes();',
      { plugin: "s3-object-boundary" },
    ),
  ).toEqual([2, 3, 4]);
});

test("accepts metadata operations bounded owner reads and local files", async () => {
  expect(
    await lintSingleRule(
      "no-native-s3-object-read",
      'import { getS3 } from "@/api/lib/s3";\ngetS3().file(key).exists();\ngetS3().file(key).stat();\nreadS3Object({key});\nBun.file("local").arrayBuffer();',
      {
        plugin: "s3-object-boundary",
        sourcePath: "apps/api/src/handlers/files/read.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("does not inherit provenance from unrelated or shadowed accessors", async () => {
  expect(
    await lintSingleRule(
      "no-native-s3-object-read",
      'import { getS3 } from "other-storage";\ngetS3().file(key).text();\nfunction read(Bun) { Bun.s3.file(key).text(); }\nfunction parameter(handle) { handle.arrayBuffer(); }',
      { plugin: "s3-object-boundary" },
    ),
  ).toEqual([]);
});

test("does not retain owner provenance for shadowed helpers or reassigned clients", async () => {
  expect(
    await lintSingleRule(
      "no-native-s3-object-read",
      'import { getS3 } from "@/api/lib/s3";\nfunction local(getS3) { getS3().file(key).text(); }\nlet client = getS3();\nclient = unrelated;\nclient.file(key).arrayBuffer();',
      {
        plugin: "s3-object-boundary",
        sourcePath: "apps/api/src/handlers/files/read.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});
