import { expect, test } from "bun:test";

import {
  publicToolDownloadPath,
  publicToolPath,
} from "@/lib/knowledge/public-tools-path";

import { isSsrDocumentRequest } from "./ssr-request";

test("tool downloads bypass the SSR deadline even with document Accept headers", () => {
  for (const publicKnowledge of [false, true]) {
    for (const slug of [
      "contract-review-example",
      "legal-research",
      "translated%20tool",
    ]) {
      const path = publicToolDownloadPath(slug, { publicKnowledge });
      for (const suffix of ["", "/", "?download=1"]) {
        const request = new Request(`https://stella.test${path}${suffix}`, {
          headers: { Accept: "text/html" },
        });
        expect(isSsrDocumentRequest(request)).toBe(false);
      }
      expect(
        isSsrDocumentRequest(
          new Request(
            `https://stella.test${publicToolPath(slug, { publicKnowledge })}`,
            { headers: { Accept: "text/html" } },
          ),
        ),
      ).toBe(true);
    }
  }
});

test("SSR deadlines apply to public documents and browser GET navigations", () => {
  expect(
    isSsrDocumentRequest(
      new Request("https://stella.test/law/cases?country=cze&q=fixture"),
    ),
  ).toBe(true);
  expect(
    isSsrDocumentRequest(
      new Request("https://stella.test/auth", {
        headers: { Accept: "text/html" },
      }),
    ),
  ).toBe(true);
  expect(isSsrDocumentRequest(new Request("https://stella.test/auth"))).toBe(
    false,
  );
  expect(
    isSsrDocumentRequest(
      new Request("https://stella.test/law", {
        method: "POST",
        headers: { Accept: "text/html" },
      }),
    ),
  ).toBe(false);
});
