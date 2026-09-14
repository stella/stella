import { expect, test } from "bun:test";

import { registryFormatHtml } from "../src/registry/registry-format";

test("registry format HTML keeps emphasis and escapes the surrounding text", () => {
  expect(
    registryFormatHtml(
      "společnost **ACME & Co. <s.r.o.>**, se sídlem *Praha*\nIČO: 27082440",
    ),
  ).toBe(
    "společnost <strong>ACME &amp; Co. &lt;s.r.o.&gt;</strong>, se sídlem <em>Praha</em><br>IČO: 27082440",
  );
});

test("registry format HTML cannot carry markup from the registry record", () => {
  expect(registryFormatHtml("**<script>alert(1)</script>**")).toBe(
    "<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>",
  );
});
