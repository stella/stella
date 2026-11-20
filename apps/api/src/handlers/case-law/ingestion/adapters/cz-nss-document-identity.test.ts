import { expect, test } from "bun:test";

import { nssDocumentReferenceMatches } from "./cz-nss-document-identity";

test("publisher header proof uses a complete parsed docket and sheet", () => {
  const reference = "5 As 140/2014-76";
  expect(
    nssDocumentReferenceMatches(reference, "5 As 140/2014 – 76\nUSNESENÍ"),
  ).toBe(true);
  for (const wrong of [
    "15 As 140/2014-76",
    "5 As 140/2014-760",
    "5 As 140/2014-75",
    "V odůvodnění je citováno 5 As 140/2014-76.\n5 As 140/2014-75",
  ]) {
    expect(
      nssDocumentReferenceMatches(
        reference,
        `${wrong}\nV odůvodnění je citováno 5 As 140/2014-76.`,
      ),
    ).toBe(false);
  }
});
