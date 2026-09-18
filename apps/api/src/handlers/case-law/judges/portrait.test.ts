/**
 * Reading a stored portrait out of the corpus store.
 *
 * The route answers with whatever this returns, so what matters here is that
 * the store's validator survives the read and that an object the store says
 * is gone is an absence rather than a failed request.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import {
  judgePortraitPath,
  readJudgePortraitObject,
} from "@/api/handlers/case-law/judges/portrait";
import { createSafeId } from "@/api/lib/branded-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";

const corpusBucket = envBase.LEGAL_CORPUS_S3_BUCKET ?? envBase.S3_BUCKET;
const KEY = "case-law/judges/portrait.jpg";
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let fake: FakeS3;

beforeEach(() => {
  fake = startFakeS3();
});

afterEach(() => {
  fake.stop();
});

test("reads the stored bytes and the store's own validator", async () => {
  fake.put(corpusBucket, KEY, BYTES, "image/jpeg");

  const portrait = await readJudgePortraitObject(
    { key: KEY, contentType: "image/jpeg" },
    AbortSignal.timeout(5000),
  );

  expect(portrait?.bytes).toEqual(BYTES);
  expect(portrait?.etag).toMatch(/^"[0-9a-f]+"$/u);
});

test("answers with no portrait when the store holds no such object", async () => {
  const portrait = await readJudgePortraitObject(
    { key: KEY, contentType: "image/jpeg" },
    AbortSignal.timeout(5000),
  );

  expect(portrait).toBeNull();
});

test("a store failure that is not an absence still fails the read", async () => {
  fake.put(corpusBucket, KEY, BYTES, "image/jpeg");
  fake.failNext({ method: "GET", code: "AccessDenied", status: 403, key: KEY });

  expect(
    readJudgePortraitObject(
      { key: KEY, contentType: "image/jpeg" },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow(/403/u);
});

test("the portrait route is addressed by the judge's id", () => {
  const judgeId = createSafeId<"caseLawJudge">();

  expect(judgePortraitPath(judgeId)).toBe(
    `/v1/case/judges/${judgeId}/portrait`,
  );
});
