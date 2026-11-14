import { describe, expect, test } from "bun:test";

import {
  createWebRouteTemplateResolver,
  resolveWebRouteTemplate,
} from "@/lib/analytics/web-hang/web-route-template";
import { WEB_ROUTE_TEMPLATES } from "@/route-templates.gen";

describe("route templates before app initialization", () => {
  test("returns generated route templates without concrete identifiers", () => {
    expect(resolveWebRouteTemplate("/chat/private-thread")).toBe(
      "/chat/$threadId",
    );
    expect(
      resolveWebRouteTemplate(
        "/workspaces/private-matter/invoices/private-invoice",
      ),
    ).toBe("/workspaces/$workspaceId/invoices/$invoiceId");
    expect(resolveWebRouteTemplate("/chat/new")).toBe("/chat/new");
    expect(resolveWebRouteTemplate("/chat/new/?document=private#private")).toBe(
      "/chat/new",
    );
    expect(resolveWebRouteTemplate("/unrecognized-private-route")).toBe(
      "unknown",
    );
  });

  test("every generated template resolves to a template, never its parameters", () => {
    for (const template of WEB_ROUTE_TEMPLATES) {
      const pathname = template.replace(
        /\{\$[\w]+\}|\$[\w]+/gu,
        "private-identifier",
      );
      const resolved = resolveWebRouteTemplate(pathname);
      expect(WEB_ROUTE_TEMPLATES.some((route) => route === resolved)).toBe(
        true,
      );
      expect(resolved).not.toContain("private-identifier");
    }
  });

  test("matches wildcard tails and affixed parameters without consuming neighboring routes", () => {
    const resolve = createWebRouteTemplateResolver([
      "/files/$",
      "/files/fixed",
      "/sitemaps/{$country}.xml",
    ]);
    expect(resolve("/files/private/path")).toBe("/files/$");
    expect(resolve("/files/fixed/")).toBe("/files/fixed");
    expect(resolve("/sitemaps/private.xml")).toBe("/sitemaps/{$country}.xml");
    expect(resolve("/sitemaps/privateXxml")).toBe("unknown");
    expect(resolve("/sitemaps/private/more.xml")).toBe("unknown");
  });
});
