import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { UPLOAD_FILE_MIN_BYTES } from "@stll/api-contract/limits";

import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";

import presignUpload from "./create";
import entityCreateTree from "./entity-create-tree";

const app = new Elysia()
  .post("/presign", ({ body }) => body, { body: presignUpload.config.body })
  .post("/tree", ({ body }) => body, { body: entityCreateTree.config.body });

const PROPERTY_ID = "00000000-0000-4000-8000-000000000001";
const SHA256_HEX = "a".repeat(64);

const post = async (path: string, body: unknown): Promise<number> =>
  (
    await app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  ).status;

const file = (size: number) => ({
  name: "notes.txt",
  mimeType: "text/plain",
  size,
  sha256Hex: SHA256_HEX,
});

describe("declared upload file size", () => {
  test.each([
    { size: 0, accepted: false },
    { size: UPLOAD_FILE_MIN_BYTES, accepted: true },
    { size: FILE_SIZE_LIMIT_BYTES.document, accepted: true },
    { size: FILE_SIZE_LIMIT_BYTES.document + 1, accepted: false },
  ])(
    "a single presign and a folder presign agree on $size bytes",
    async ({ size, accepted }) => {
      const single = await post("/presign", {
        purpose: "entity_create",
        propertyId: PROPERTY_ID,
        ...file(size),
      });
      const folder = await post("/tree", {
        propertyId: PROPERTY_ID,
        directories: [],
        files: [{ key: "0", parentKey: null, ...file(size) }],
      });

      expect({ single, folder }).toEqual(
        accepted ? { single: 200, folder: 200 } : { single: 422, folder: 422 },
      );
    },
  );
});
