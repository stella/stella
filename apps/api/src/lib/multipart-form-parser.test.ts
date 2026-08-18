import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";

import {
  multipartFormParser,
  parseMultipartForm,
} from "@/api/lib/multipart-form-parser";

const file = (name: string) => new File(["body"], name, { type: "text/plain" });

const formData = (entries: [string, string | File][]): FormData => {
  const data = new FormData();
  for (const [key, value] of entries) {
    data.append(key, value);
  }
  return data;
};

/** Round-trips the form through a real request, so the parser sees exactly
 *  what a route hands it. */
const parse = async (entries: [string, string | File][]) => {
  const request = new Request("http://localhost/probe", {
    method: "POST",
    body: formData(entries),
  });
  // eslint-disable-next-line typescript/no-deprecated -- the parser under test consumes exactly this form
  return parseMultipartForm(await request.formData());
};

describe("parseMultipartForm", () => {
  test("keeps a JSON-shaped value as the string that was sent", async () => {
    const values = '{"party.name":"Acme"}';
    expect(await parse([["values", values]])).toEqual({ values });
  });

  test("keeps an array-shaped value as a string", async () => {
    expect(await parse([["entityIds", '["a","b"]']])).toEqual({
      entityIds: '["a","b"]',
    });
  });

  test("keeps a file as a file", async () => {
    const parsed = (await parse([["file", file("contract.docx")]]))["file"];

    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("expected the field to stay a file");
    }
    expect(parsed.name).toBe("contract.docx");
    expect(await parsed.text()).toBe("body");
  });

  test("collects a repeated key into an array in wire order", async () => {
    const parsed = await parse([
      ["files", file("a.docx")],
      ["files", file("b.docx")],
    ]);

    const files = parsed["files"];
    if (!Array.isArray(files)) {
      throw new TypeError("expected a repeated key to collect into an array");
    }
    expect(
      files.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).toEqual(["a.docx", "b.docx"]);
  });

  test("keeps a single-entry key unwrapped", async () => {
    expect(
      Array.isArray((await parse([["files", file("a.docx")]]))["files"]),
    ).toBe(false);
  });

  test("drops prototype-polluting keys", async () => {
    const parsed = await parse([
      ["__proto__", '{"polluted":true}'],
      ["constructor", "x"],
      ["prototype", "x"],
      ["name", "kept"],
    ]);

    expect(parsed).toEqual({ name: "kept" });
    expect("polluted" in {}).toBe(false);
  });

  test("does not confuse an inherited property with a repeated key", async () => {
    expect(await parse([["toString", "once"]])).toEqual({ toString: "once" });
  });
});

describe("multipartFormParser plugin", () => {
  test("a t.String() field carrying JSON reaches the handler as a string", async () => {
    const app = new Elysia()
      .use(multipartFormParser)
      .post("/fill", ({ body }) => body.values, {
        body: t.Object({ file: t.File(), values: t.String() }),
      });

    const response = await app.handle(
      new Request("http://localhost/fill", {
        method: "POST",
        body: formData([
          ["file", file("template.docx")],
          ["values", '{"party.name":"Acme"}'],
        ]),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"party.name":"Acme"}');
  });

  test("t.Files() still receives every uploaded file", async () => {
    const app = new Elysia()
      .use(multipartFormParser)
      .post("/upload", ({ body }) => String(body.files.length), {
        body: t.Object({ files: t.Files() }),
      });

    const response = await app.handle(
      new Request("http://localhost/upload", {
        method: "POST",
        body: formData([
          ["files", file("a.docx")],
          ["files", file("b.docx")],
        ]),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("2");
  });

  test("t.Files() still accepts a single uploaded file", async () => {
    const app = new Elysia()
      .use(multipartFormParser)
      .post("/upload", ({ body }) => String(body.files.length), {
        body: t.Object({ files: t.Files() }),
      });

    const response = await app.handle(
      new Request("http://localhost/upload", {
        method: "POST",
        body: formData([["files", file("a.docx")]]),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("1");
  });

  test("a route that declares parse: none keeps its unread request body", async () => {
    const app = new Elysia()
      .use(multipartFormParser)
      .all("/raw", async ({ request }) => await request.text(), {
        parse: "none",
      });

    const response = await app.handle(
      new Request("http://localhost/raw", {
        method: "POST",
        body: '{"jsonrpc":"2.0"}',
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"jsonrpc":"2.0"}');
  });

  test("a route that declares parse: text still gets the raw body string", async () => {
    const app = new Elysia()
      .use(multipartFormParser)
      .post("/webhook", ({ body }) => body, {
        body: t.String(),
        parse: "text",
      });

    const response = await app.handle(
      new Request("http://localhost/webhook", {
        method: "POST",
        body: '{"signed":"bytes"}',
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"signed":"bytes"}');
  });

  test("a mounted handler keeps its request body", async () => {
    const app = new Elysia()
      .use(multipartFormParser)
      .mount(
        "/mounted",
        async (request: Request) => new Response(await request.text()),
      );

    const response = await app.handle(
      new Request("http://localhost/mounted/session", {
        method: "POST",
        body: '{"email":"a@b.c"}',
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"email":"a@b.c"}');
  });
});
