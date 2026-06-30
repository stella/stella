import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { permissionMacro } from "@/api/lib/auth";
import {
  hasMemberPermission,
  readAuthorizedMemberRole,
} from "@/api/lib/permission-authorization";

describe("permission authorization", () => {
  test("reads only known member roles from request context", () => {
    const contextWithInheritedMemberRole: object = Object.create({
      memberRole: { role: "owner" },
    });
    const memberRoleWithInheritedRole: object = Object.create({
      role: "owner",
    });

    expect(readAuthorizedMemberRole({ memberRole: { role: "owner" } })).toEqual(
      { role: "owner" },
    );
    expect(readAuthorizedMemberRole({})).toBeNull();
    expect(readAuthorizedMemberRole({ memberRole: null })).toBeNull();
    expect(readAuthorizedMemberRole(contextWithInheritedMemberRole)).toBeNull();
    expect(
      readAuthorizedMemberRole({ memberRole: memberRoleWithInheritedRole }),
    ).toBeNull();
    expect(
      readAuthorizedMemberRole({ memberRole: { role: "custom" } }),
    ).toBeNull();
    expect(
      readAuthorizedMemberRole({ memberRole: { role: "constructor" } }),
    ).toBeNull();
  });

  test("authorizes from the local role map", () => {
    expect(
      hasMemberPermission({ role: "owner" }, { organization: ["delete"] }),
    ).toBe(true);
    expect(
      hasMemberPermission({ role: "member" }, { organization: ["delete"] }),
    ).toBe(false);
    expect(
      hasMemberPermission({ role: "external" }, { workspace: ["read"] }),
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
