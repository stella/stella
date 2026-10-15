import { assertSsrDocument } from "@stll/ssr-testkit";

import { expect, test } from "../helpers/test";

const SSR_RESPONSE_TIMEOUT_MS = 20_000;

for (const query of ["27 Cdo 59/2022", "fiktivní", ""]) {
  test(`case search serves a complete server document for ${query || "browse"}`, async ({
    request,
  }) => {
    const response = await request.get("/law/cases", {
      params: { country: "cze", ...(query && { q: query }) },
      headers: { Accept: "text/html" },
      timeout: SSR_RESPONSE_TIMEOUT_MS,
    });
    const html = await response.text();
    assertSsrDocument({
      status: response.status(),
      contentType: response.headers()["content-type"] ?? null,
      html,
      requiredContent: ["<main", "</body></html>"],
    });
    // A terminated failed shell is still incomplete: the route must have
    // rendered its search input, beyond the outer pending boundary.
    expect(html).toContain(`value="${query}"`);
  });
}
