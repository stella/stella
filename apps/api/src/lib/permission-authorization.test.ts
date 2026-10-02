import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { permissionMacro } from "@/api/lib/auth";
import {
  hasMemberPermission,
  readAuthorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";

describe("permission authorization", () => {
  test("reads only known member roles from request context", () => {
    const contextWithInheritedMemberRole: object = Object.create({
      memberRole: sessionMemberRole("owner"),
    });
    const memberRoleWithInheritedRole: object = Object.create({
      role: "owner",
    });

    expect(
      readAuthorizedMemberRole({ memberRole: sessionMemberRole("owner") }),
    ).toEqual({ role: "owner" });
    expect(readAuthorizedMemberRole({})).toBeNull();
    expect(readAuthorizedMemberRole({ memberRole: null })).toBeNull();
    expect(readAuthorizedMemberRole(contextWithInheritedMemberRole)).toBeNull();
    expect(
      readAuthorizedMemberRole({ memberRole: memberRoleWithInheritedRole }),
    ).toBeNull();
    expect(
      readAuthorizedMemberRole({ memberRole: sessionMemberRole("custom") }),
    ).toBeNull();
    expect(
      readAuthorizedMemberRole({
        memberRole: sessionMemberRole("constructor"),
      }),
    ).toBeNull();
  });

  test("authorizes from the local role map", () => {
    expect(
      hasMemberPermission(sessionMemberRole("owner"), {
        organization: ["delete"],
      }),
    ).toBe(true);
    expect(
      hasMemberPermission(sessionMemberRole("member"), {
        organization: ["delete"],
      }),
    ).toBe(false);
    expect(
      hasMemberPermission(sessionMemberRole("external"), {
        workspace: ["read"],
      }),
    ).toBe(true);
  });

  test("permission macro authenticates before checking permissions", async () => {
    const app = new Elysia()
      .use(permissionMacro)
      .get("/protected", () => ({ ok: true }), {
        permissions: { workspace: ["read"] },
      });

    const response = await app.handle(
      new Request("http://localhost/protected"),
    );

    expect(response.status).toBe(401);
  });
});
