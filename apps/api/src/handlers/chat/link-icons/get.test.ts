import { expect, test } from "bun:test";
import Elysia from "elysia";

import getLinkIcon from "@/api/handlers/chat/link-icons/get";
import { linkIconBody } from "@/api/handlers/chat/link-icons/response";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

test("favicon bytes require an authenticated chat principal", async () => {
  const app = new Elysia()
    .use(workspaceAccessMacro)
    .use(permissionMacro)
    .guard({ validateAuth: true })
    .get("/chat/link-icons/:hostname", getLinkIcon.handler, {
      params: getLinkIcon.config.params,
      permissions: getLinkIcon.config.permissions,
    });
  const response = await app.handle(
    new Request("http://localhost/chat/link-icons/example.com"),
  );
  expect(response.status).toBe(401);
});

test("missing icons have a typed fallback and private nosniff headers", async () => {
  const response = await new Elysia()
    .get("/", ({ set }) => linkIconBody({ type: "no-icon" }, set))
    .handle(new Request("http://localhost/"));
  expect(await response.json()).toEqual({ type: "no-icon" });
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toContain("private");
});

test("verified bytes retain their MIME and never expose the origin URL", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const response = await new Elysia()
    .get("/", ({ set }) =>
      linkIconBody({ type: "icon", icon: { bytes, mime: "image/png" } }, set),
    )
    .handle(new Request("http://localhost/"));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.has("location")).toBe(false);
});

test("temporary icon refusals are never cached by the browser", async () => {
  const response = await new Elysia()
    .get("/", ({ set }) => linkIconBody({ type: "temporary" }, set))
    .handle(new Request("http://localhost/"));
  expect(await response.json()).toEqual({ type: "temporary" });
  expect(response.headers.get("cache-control")).toContain("no-store");
});
