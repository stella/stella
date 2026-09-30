import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  readMarkupText,
  type MarkupTextExclusion,
  type MarkupXmlDialect,
} from "./markup";
import { TEXT_ORACLE_LIMITS } from "./types";

const raw = (text: string) => new TextEncoder().encode(text);
const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
const baseline = (source: string, format: "html" | "xml") => {
  const result = readMarkupText({ raw: raw(source), format });
  if (Result.isError(result)) {
    throw result.error;
  }
  return normalize(result.value.text);
};

const exclusion = {
  type: "element",
  name: "nav",
  attribute: { name: "id", value: "publisher" },
  reason: "Publisher navigation outside the decision",
  evidence: "Home Decisions",
} as const satisfies MarkupTextExclusion;

const expectFailure = (
  result: ReturnType<typeof readMarkupText>,
  reason: string,
) => {
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.reason).toBe(reason);
  }
};

describe("independent markup text baseline", () => {
  test("retains inline segmentation, bare text, captions, unknown wrappers and repeated occurrences", () => {
    expect(
      baseline(
        "Bare <p>ju<x-inline>dg</x-inline>ment &amp; law</p><unknown>repeated repeated</unknown><table><caption>Caption</caption><tr><td>Cell</td></tr></table>",
        "html",
      ),
    ).toBe("Bare judgment & law repeated repeated Caption Cell");
  });

  test("retains image alternative text with lexical boundaries and hidden image semantics", () => {
    expect(
      baseline(
        'Before<img alt="Visible &amp; caption">After<img hidden alt="Hidden caption"><img alt="Repeated"><img alt="Repeated">',
        "html",
      ),
    ).toBe("Before Visible & caption After Repeated Repeated");
  });

  test("explicit XML dialects delimit structural blocks without dropping unknown wrappers", () => {
    const recipes = [
      {
        dialect: "xpart",
        source:
          "<xName>Name</xName><xTitle>Title</xTitle><xUnit><xText>Alpha</xText><xText>Beta</xText></xUnit><xClmn>Cell</xClmn>",
        expected: "Name Title Alpha Beta Cell",
      },
      {
        dialect: "ris",
        source:
          "<ueberschrift>Title</ueberschrift><absatz>Alpha</absatz><Textabsatz>Beta</Textabsatz>",
        expected: "Title Alpha Beta",
      },
      {
        dialect: "findok",
        source: "<h1>Title</h1><p>Alpha</p><p>Beta</p>",
        expected: "Title Alpha Beta",
      },
      {
        dialect: "formex",
        source:
          "<TITLE><TI>Title</TI></TITLE><NP.ECR><NO.P>1</NO.P><P>Alpha</P></NP.ECR><NOTE>Note</NOTE>",
        expected: "Title 1 Alpha Note",
      },
    ] as const satisfies readonly {
      dialect: MarkupXmlDialect;
      source: string;
      expected: string;
    }[];
    for (const { dialect, source, expected } of recipes) {
      const result = readMarkupText({
        raw: raw(`<root><unknown>${source}</unknown></root>`),
        format: "xml",
        xmlDialect: dialect,
      });
      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(normalize(result.value.text)).toBe(expected);
      }
    }
    expect(
      baseline("<root><xText>Alpha</xText><xText>Beta</xText></root>", "xml"),
    ).toBe("AlphaBeta");
  });

  test("FINDOK renders every escaped XHTML txt without counting tag spellings", () => {
    const result = readMarkupText({
      raw: raw(
        '<root><unknown>Publisher</unknown><Segk><txt>&lt;html&gt;&lt;body&gt;&lt;p&gt;Alpha &amp;amp; law&lt;/p&gt;&lt;p&gt;Repeated&lt;/p&gt;&lt;img alt="Caption"/&gt;&lt;script&gt;ignored&lt;/script&gt;&lt;/body&gt;&lt;/html&gt;</txt></Segk><other><txt>&lt;p&gt;Repeated&lt;/p&gt;</txt></other><p>Tail</p></root>',
      ),
      format: "xml",
      xmlDialect: "findok",
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(normalize(result.value.text)).toBe(
        "Publisher Alpha & law Repeated Caption Repeated Tail",
      );
      expect(result.value.text).not.toContain("<p>");
    }
  });

  test("is invariant under insertion of arbitrary inline wrappers", () => {
    const text = "Příliš žluťoučký kůň 司法 repeated repeated";
    for (let split = 0; split <= text.length; split++) {
      const source = `<p>${text.slice(0, split)}<unrecognized>${text.slice(split)}</unrecognized></p>`;
      expect(baseline(source, "html")).toBe(text);
      expect(baseline(`<root>${source}</root>`, "xml")).toBe(text);
    }
  });

  test("HTML explicitly ignores non-rendered elements and hidden descendant text", () => {
    expect(
      baseline(
        '<html><head><title>Title</title></head><body>Visible<script>code</script><style>css</style><template>template</template><p hidden>hidden <b>child</b></p><p style="display: none !important">display</p><p style="visibility:hidden">visibility</p><p aria-hidden="true">still visible</p></body></html>',
        "html",
      ),
    ).toBe("Visible still visible");
  });

  test("visibility can be restored by a descendant, while display none hides the subtree", () => {
    expect(
      baseline(
        '<div style="visibility:hidden">hidden<span style="visibility:visible">restored</span></div><div style="display:none"><span style="visibility:visible">still hidden</span></div>',
        "html",
      ),
    ).toBe("restored");
  });

  test("XML exclusions bind case-sensitive element and attribute names to exact text evidence", () => {
    const result = readMarkupText({
      raw: raw(
        '<root><nav id="publisher">Home Decisions</nav><p>Judgment</p></root>',
      ),
      format: "xml",
      exclusions: [exclusion],
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(normalize(result.value.text)).toBe("Judgment");
    }
    expectFailure(
      readMarkupText({
        raw: raw('<root><Nav id="publisher">Home Decisions</Nav></root>'),
        format: "xml",
        exclusions: [exclusion],
      }),
      "malformed",
    );
  });

  test("XML retains CDATA, generic metadata, deleted and hidden wrappers", () => {
    expect(
      baseline(
        '<root><metadata>Publisher</metadata><deleted>Deleted</deleted><unknown hidden="true"><![CDATA[<visible> & text]]></unknown><p>ju<x>dg</x>ment</p><!-- ignore --><?instruction ignored?></root>',
        "xml",
      ),
    ).toBe("PublisherDeleted<visible> & text judgment");
  });

  test("evidenced exclusions remove only matched publisher furniture", () => {
    const result = readMarkupText({
      raw: raw(
        '<nav id="publisher">Home <span>Decisions</span></nav><p>Home Decisions judgment</p>',
      ),
      format: "html",
      exclusions: [exclusion],
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(normalize(result.value.text)).toBe("Home Decisions judgment");
    }
  });

  test("exclusions reject absent targets, changed text, and blank reasons", () => {
    expectFailure(
      readMarkupText({
        raw: raw("<p>Judgment</p>"),
        format: "html",
        exclusions: [exclusion],
      }),
      "malformed",
    );
    expectFailure(
      readMarkupText({
        raw: raw('<nav id="publisher">Judgment now appears here</nav>'),
        format: "html",
        exclusions: [exclusion],
      }),
      "malformed",
    );
    expectFailure(
      readMarkupText({
        raw: raw('<nav id="publisher">Home Decisions</nav>'),
        format: "html",
        exclusions: [{ ...exclusion, reason: " " }],
      }),
      "malformed",
    );
  });

  test("rejects malformed XML and entity-bearing input", () => {
    expectFailure(
      readMarkupText({ raw: raw("<root><p></root>"), format: "xml" }),
      "malformed",
    );
    expectFailure(
      readMarkupText({
        raw: raw(
          '<!DOCTYPE root [<!ENTITY x SYSTEM "file:///etc/passwd">]><root>&x;</root>',
        ),
        format: "xml",
      }),
      "unsupported",
    );
    expectFailure(
      readMarkupText({ raw: new Uint8Array([0xff]), format: "html" }),
      "malformed",
    );
  });

  test("fails on depth, text, and raw-byte exhaustion without returning truncated text", () => {
    const source = `${"<x>".repeat(
      TEXT_ORACLE_LIMITS.depth + 1,
    )}visible${"</x>".repeat(TEXT_ORACLE_LIMITS.depth + 1)}`;
    expectFailure(
      readMarkupText({ raw: raw(source), format: "xml" }),
      "resource_limit",
    );
    expectFailure(
      readMarkupText({
        raw: raw(`<p>${"x".repeat(TEXT_ORACLE_LIMITS.textCharacters + 1)}</p>`),
        format: "html",
      }),
      "resource_limit",
    );
    expectFailure(
      readMarkupText({
        raw: new Uint8Array(TEXT_ORACLE_LIMITS.rawBytes + 1),
        format: "html",
      }),
      "resource_limit",
    );
  });
});
