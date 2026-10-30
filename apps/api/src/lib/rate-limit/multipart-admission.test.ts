import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  admitMultipartRequest,
  MULTIPART_REQUEST_MAX_BYTES,
} from "@/api/lib/rate-limit/multipart-admission";

describe("admitMultipartRequest", () => {
  test("refuses a declared oversized multipart body before parsing", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: "not read",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        "content-length": String(MULTIPART_REQUEST_MAX_BYTES + 1),
      },
    });

    const admitted = await admitMultipartRequest(request);

    expect(Result.isError(admitted)).toBe(true);
    expect(request.bodyUsed).toBe(false);
  });

  test("refuses an upper-case multipart media type the same way", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: "not read",
      headers: {
        "content-type": "Multipart/Form-Data; boundary=test",
        "content-length": String(MULTIPART_REQUEST_MAX_BYTES + 1),
      },
    });

    const admitted = await admitMultipartRequest(request);

    expect(Result.isError(admitted)).toBe(true);
  });

  test("leaves non-multipart request bodies unread", async () => {
    const request = new Request("http://localhost/raw", {
      method: "POST",
      body: "raw body",
      headers: { "content-type": "application/json" },
    });

    const admitted = await admitMultipartRequest(request);

    expect(Result.isOk(admitted) && admitted.value).toBe(request);
    expect(request.bodyUsed).toBe(false);
  });
});
