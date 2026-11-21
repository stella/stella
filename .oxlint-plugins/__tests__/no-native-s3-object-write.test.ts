import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects native client file and Bun writer calls", async () => {
  expect(
    await lintSingleRule(
      "no-native-s3-object-write",
      'import { getS3 as storage } from "@/api/lib/s3";\nconst client = storage();\nclient.write(key, bytes);\nconst handle = client.file(key);\nhandle.write(bytes);\nBun.write(handle, bytes);',
      {
        plugin: "s3-object-boundary",
        sourcePath: "apps/api/src/handlers/files/read.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([3, 5, 6]);
});

test("rejects AWS PutObject commands through import aliases", async () => {
  expect(
    await lintSingleRule(
      "no-native-s3-object-write",
      'import { PutObjectCommand as Put } from "@aws-sdk/client-s3";\nclient.send(new Put({Key:key}));',
      { plugin: "s3-object-boundary" },
    ),
  ).toEqual([2]);
});

test("accepts owned retries metadata operations and local writes", async () => {
  expect(
    await lintSingleRule(
      "no-native-s3-object-write",
      'writeS3ObjectWithRetry({key, data:bytes});\nBun.write("local", bytes);\nBun.file("local").write(bytes);\nclient.delete(key);',
      { plugin: "s3-object-boundary" },
    ),
  ).toEqual([]);
});

test("does not trust unrelated SDK commands or shadowed Bun clients", async () => {
  expect(
    await lintSingleRule(
      "no-native-s3-object-write",
      'import { PutObjectCommand } from "other-sdk";\nclient.send(new PutObjectCommand({Key:key}));\nfunction local(Bun) { Bun.s3.write(key, bytes); }',
      { plugin: "s3-object-boundary" },
    ),
  ).toEqual([]);
});

test("does not retain owner provenance for shadowed helpers or reassigned clients", async () => {
  expect(
    await lintSingleRule(
      "no-native-s3-object-write",
      'import { getS3 } from "@/api/lib/s3";\nfunction local(getS3) { getS3().write(key, bytes); }\nlet client = getS3();\nclient = unrelated;\nclient.write(key, bytes);',
      {
        plugin: "s3-object-boundary",
        sourcePath: "apps/api/src/handlers/files/read.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});
