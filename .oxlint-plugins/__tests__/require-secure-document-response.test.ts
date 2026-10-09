import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("requires the response owner for file handler bodies", async () => {
  expect(
    await lintSingleRule(
      "require-secure-document-response",
      "const response = new Response(bytes);",
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/files/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([1]);
});

test("allows bodyless responses and the secure response owner", async () => {
  expect(
    await lintSingleRule(
      "require-secure-document-response",
      "const empty = new Response(null, { status: 204 });\nconst response = secureDocumentResponse(file);",
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/files/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("reports attachment responses outside file handlers", async () => {
  expect(
    await lintSingleRule(
      "require-secure-document-response",
      'const response = new Response(bytes, { headers: { "Content-Disposition": "attachment; filename=document.pdf" } });',
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([1]);
});

test("rejects manual import aliases for document security headers", async () => {
  expect(
    await lintSingleRule(
      "require-secure-document-response",
      'import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS as headers } from "@/api/lib/security-headers";',
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/files/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([1]);
});

test("allows unrelated responses outside file handlers", async () => {
  expect(
    await lintSingleRule(
      "require-secure-document-response",
      'const response = new Response("ready");',
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("requires the response owner for attachment Headers bindings", async () => {
  expect(
    await lintSingleRule(
      "require-secure-document-response",
      `const headers = new Headers({ "Content-Disposition": "attachment; filename=document.pdf" });
const response = new Response(bytes, { headers });`,
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([2]);
});
test("allows unrelated Headers bindings outside file handlers", async () => {
  expect(
    await lintSingleRule(
      "require-secure-document-response",
      `const headers = new Headers({ "Content-Type": "text/plain" });
const response = new Response("ready", { headers });`,
      {
        plugin: "security-guards",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});
