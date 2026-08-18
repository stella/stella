import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import previewContactImport from "@/api/handlers/contacts/import-preview";

// Elysia parses a JSON-shaped multipart field into an object before route
// validation, so a body schema that only accepts a string rejects the
// mapping the studio sends. This mounts the real body schema (without the
// authenticated handler) and asserts the multipart request survives
// validation in both the string and the parsed-object form.
const app = new Elysia().post("/preview", ({ body }) => typeof body.mapping, {
  body: previewContactImport.config.body,
});

const post = async (mapping: string) => {
  const form = new FormData();
  form.append("file", new File(["Name\nJane"], "c.csv", { type: "text/csv" }));
  form.append("mapping", mapping);
  return app.handle(
    new Request("http://localhost/preview", { method: "POST", body: form }),
  );
};

describe("contact import preview body", () => {
  test("accepts a JSON-shaped mapping field", async () => {
    const response = await post(
      JSON.stringify({ version: 1, columns: [{ sourceIndex: 0 }] }),
    );

    expect(response.status).toBe(200);
    // Documents the framework behavior the handler tolerates: the JSON
    // string reaches the route already parsed.
    expect(await response.text()).toBe("object");
  });

  test("accepts a plain string mapping field", async () => {
    const response = await post("not json");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("string");
  });
});
