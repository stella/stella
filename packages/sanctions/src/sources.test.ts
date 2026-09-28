import { describe, expect, test } from "bun:test";

import { readSourceEditionMarker } from "./sources";

describe("source edition markers", () => {
  test("reads OFAC's HEAD validator and the Commission's checksum", () => {
    expect(
      readSourceEditionMarker("us-sdn", {
        lastModified: "Wed, 23 Sep 2026 14:07:28 GMT",
      }).unwrap(),
    ).toEqual({
      source: "us-sdn",
      value: "2026-09-23T14:07:28Z",
      downloadUrl: null,
    });
    expect(
      readSourceEditionMarker("eu", {
        body: "24A260F97C24B68F5B4BA79F0DA7A747C3CB8F62\n",
      }).unwrap().value,
    ).toBe("24a260f97c24b68f5b4ba79f0da7a747c3cb8f62");
    expect(readSourceEditionMarker("us-non-sdn", {}).isErr()).toBe(true);
    expect(readSourceEditionMarker("eu", { body: "error page" }).isErr()).toBe(
      true,
    );
  });

  test("reads the UN publication date and the newest Czech dated attachment", () => {
    expect(
      readSourceEditionMarker("un", {
        body: "<p>The Consolidated Sanctions List maintained on this website was last updated on 4 September 2026 and supersedes all previous versions.</p>",
      }).unwrap().value,
    ).toBe("2026-09-04");
    expect(
      readSourceEditionMarker("un", {
        body: `${"<".repeat(10_000)}<p>last updated on 4 September 2026</p>`,
      }).unwrap().value,
    ).toBe("2026-09-04");
    expect(
      readSourceEditionMarker("cz", {
        body: '<a href="/file/100/Vnitrostatni_sankcni_seznam_2025_01_01.csv"></a><a href="/file/6248997/Vnitrostatni_sankcni_seznam_2026_07_23.csv">CSV</a>',
      }).unwrap(),
    ).toEqual({
      source: "cz",
      value:
        "https://mzv.gov.cz/file/6248997/Vnitrostatni_sankcni_seznam_2026_07_23.csv",
      downloadUrl:
        "https://mzv.gov.cz/file/6248997/Vnitrostatni_sankcni_seznam_2026_07_23.csv",
    });
    expect(readSourceEditionMarker("cz", { body: "no CSV link" }).isErr()).toBe(
      true,
    );
  });
});
