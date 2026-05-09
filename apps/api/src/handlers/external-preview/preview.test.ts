import { describe, expect, test } from "bun:test";

import {
  extractReadableMarkdownFromHtml,
  extractReadableTextFromHtml,
  isPdfBytes,
  isPdfPreview,
  isPdfPreviewResponse,
} from "@/api/handlers/external-preview/preview";

describe("external source preview", () => {
  test("extracts readable text from the largest generic content block", () => {
    const text = extractReadableTextFromHtml(`
      <html>
        <body>
          <nav>Navigation only</nav>
          <div>
            <p>Short teaser</p>
          </div>
          <main>
            <div>Zákon č. 301/2009 Sb.</div>
            <div>Parlament se usnesl na tomto zákoně České republiky.</div>
            <div>§ 24 Pravidla pro provoz letišť.</div>
          </main>
        </body>
      </html>
    `);

    expect(text).toContain("Zákon č. 301/2009 Sb.");
    expect(text).toContain("§ 24 Pravidla pro provoz letišť.");
    expect(text).not.toContain("Navigation only");
  });

  test("keeps leaf block formatting without duplicating container text", () => {
    const markdown = extractReadableMarkdownFromHtml(
      `
        <html>
          <body>
            <main>
              <div>
                <div>301</div>
                <div>ZÁKON</div>
                <div>ze dne 23. července 2009</div>
                <div>§ 24 Pravidla pro provoz letišť.</div>
              </div>
            </main>
          </body>
        </html>
      `,
      new URL("https://krajta.example/2009/301"),
    );

    expect(markdown).toBe(
      [
        "301",
        "ZÁKON",
        "ze dne 23. července 2009",
        "§ 24 Pravidla pro provoz letišť.",
      ].join("\n\n"),
    );
  });

  test("does not treat HTML error pages on .pdf URLs as PDF previews", () => {
    expect(
      isPdfPreview("text/html", new URL("https://example.test/document.pdf")),
    ).toBe(false);
    expect(
      isPdfPreview(
        "application/octet-stream",
        new URL("https://example.test/document.pdf"),
      ),
    ).toBe(true);
  });

  test("recognizes only real PDF bytes", () => {
    expect(isPdfBytes(new TextEncoder().encode("%PDF-1.7\n").buffer)).toBe(
      true,
    );
    expect(isPdfBytes(new TextEncoder().encode("<html></html>").buffer)).toBe(
      false,
    );
  });

  test("preserves PDF detection when redirects hide the original extension", () => {
    expect(
      isPdfPreviewResponse({
        body: new TextEncoder().encode("%PDF-1.4\n").buffer,
        contentType: "application/octet-stream",
        requestedUrl: new URL("https://example.test/document.pdf"),
        responseUrl: new URL("https://cdn.example.test/signed-token"),
      }),
    ).toBe(true);

    expect(
      isPdfPreviewResponse({
        body: new TextEncoder().encode("<html></html>").buffer,
        contentType: "application/octet-stream",
        requestedUrl: new URL("https://example.test/document.pdf"),
        responseUrl: new URL("https://cdn.example.test/signed-token"),
      }),
    ).toBe(true);

    expect(
      isPdfPreviewResponse({
        body: new TextEncoder().encode("<html></html>").buffer,
        contentType: "application/octet-stream",
        requestedUrl: new URL("https://example.test/document"),
        responseUrl: new URL("https://cdn.example.test/signed-token"),
      }),
    ).toBe(false);
  });
});
