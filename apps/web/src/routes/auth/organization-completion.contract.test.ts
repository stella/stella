import { expect, test } from "bun:test";

const organizationRouteSource = await Bun.file(
  new URL("organization.tsx", import.meta.url),
).text();

test("organization completion refreshes auth state without self-invalidating its redirect guard", () => {
  const completionStart = organizationRouteSource.indexOf(
    "const completeOrganizationFlow",
  );
  const completionEnd = organizationRouteSource.indexOf(
    "const OrganizationList",
    completionStart,
  );

  expect(completionStart).toBeGreaterThan(-1);
  expect(completionEnd).toBeGreaterThan(completionStart);
  expect(organizationRouteSource).toContain(
    "context.session.activeOrganizationId",
  );

  const completionSource = organizationRouteSource.slice(
    completionStart,
    completionEnd,
  );
  expect(completionSource).toContain("await refreshAuthQueries(queryClient)");
  expect(completionSource).not.toContain("router.invalidate");
  expect(completionSource).not.toContain("invalidateSession");
});
