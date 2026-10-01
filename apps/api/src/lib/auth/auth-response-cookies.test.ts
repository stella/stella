import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { forwardAuthResponseCookies } from "@/api/lib/auth/auth-response-cookies";

describe("session cookie forwarding", () => {
  test("preserves separate cookies and existing response cookies through HTTP", async () => {
    const authHeaders = new Headers();
    authHeaders.append("set-cookie", "session=new; HttpOnly; Path=/");
    authHeaders.append(
      "set-cookie",
      "snapshot=value; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
    );
    const app = new Elysia().get("/", ({ set }) => {
      set.headers["set-cookie"] = "existing=kept; Path=/";
      set.headers["x-existing"] = "kept";
      forwardAuthResponseCookies(set.headers, authHeaders);
      forwardAuthResponseCookies(
        set.headers,
        new Headers({ "set-cookie": "another=kept; Path=/" }),
      );
      return "ok";
    });
    const response = await app.handle(new Request("http://localhost/"));
    expect(response.headers.getSetCookie()).toEqual([
      "existing=kept; Path=/",
      "session=new; HttpOnly; Path=/",
      "snapshot=value; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
      "another=kept; Path=/",
    ]);
    expect(response.headers.get("x-existing")).toBe("kept");
  });

  test("leaves response headers unchanged when no auth cookie was issued", () => {
    const headers = {
      "set-cookie": "existing=kept; Path=/",
      "x-existing": "kept",
    };
    forwardAuthResponseCookies(headers, new Headers());
    expect(headers).toEqual({
      "set-cookie": "existing=kept; Path=/",
      "x-existing": "kept",
    });
  });
});
