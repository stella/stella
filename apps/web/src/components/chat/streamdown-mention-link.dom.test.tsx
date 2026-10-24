import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { ChatSourceCitationTarget } from "@stll/api-contract";
import { sleep } from "@stll/concurrency/sleep";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { isFolioBlockId } = await import("@stll/folio-react");
const { toChatSourceCitationHref } = await import("@stll/api-contract");
const { toSafeId } = await import("@/lib/safe-id");
const { DocumentIcon } = await import("@/components/document-icon");
const { getDocumentIconKind } =
  await import("@/components/document-icon.logic");
const { DOCX_MIME, PDF_MIME, PPTX_MIME, XLSX_MIME } =
  await import("@/lib/consts");
const { sourceCitationMimeType } = await import("./citation-file-type.logic");
const { StreamdownMentionLink } = await import("./streamdown-mention-link");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const identity = {
  workspaceId: toSafeId<"workspace">("11111111-1111-4111-8111-111111111111"),
  entityId: toSafeId<"entity">("22222222-2222-4222-8222-222222222222"),
  entityVersionId: toSafeId<"entityVersion">(
    "33333333-3333-4333-8333-333333333333",
  ),
  fieldId: toSafeId<"field">("44444444-4444-4444-8444-444444444444"),
};

const docxTarget = {
  ...identity,
  type: "docx-folio",
  blockId: "seq-0007",
  text: "Termination clause",
} satisfies ChatSourceCitationTarget;
const pdfTarget = {
  ...identity,
  type: "pdf-bates",
  bates: "ABC000123",
  pageNumber: 4,
} satisfies ChatSourceCitationTarget;

// One fixture per target kind: a kind added to the contract fails to
// typecheck here until it gets a fixture (and a mapping in the logic file).
const TARGETS = {
  "docx-folio": docxTarget,
  "pdf-bates": pdfTarget,
} satisfies {
  [K in ChatSourceCitationTarget["type"]]: Extract<
    ChatSourceCitationTarget,
    { type: K }
  >;
};

const CHIP_LABEL = "Cited passage";

const renderChip = (href: string, workspaceId?: string) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <p>
          <StreamdownMentionLink
            href={href}
            interactive
            workspaceId={workspaceId}
          >
            {CHIP_LABEL}
          </StreamdownMentionLink>
        </p>
      </IntlProvider>
    </QueryClientProvider>,
  );

const sharedGlyph = (mimeType: string): string => {
  const view = render(
    <DocumentIcon className="size-3 shrink-0" mimeType={mimeType} />,
  );
  const html = view.container.innerHTML;
  view.unmount();
  return html;
};

const chipGlyph = (container: HTMLElement): string => {
  const svg = container.querySelector("svg");
  if (svg === null) {
    throw new Error("chip rendered no icon");
  }
  return svg.outerHTML;
};

describe("inline citation chips draw the cited file's type", () => {
  test("every source citation kind maps to the file format it addresses", () => {
    expect(
      Object.fromEntries(
        Object.values(TARGETS).map((target) => [
          target.type,
          getDocumentIconKind(sourceCitationMimeType(target.type)),
        ]),
      ),
    ).toEqual({ "docx-folio": "word", "pdf-bates": "pdf" });
  });

  test("a docx citation draws the shared Word glyph", () => {
    const view = renderChip(toChatSourceCitationHref(TARGETS["docx-folio"]));
    const glyph = chipGlyph(view.container);
    expect(glyph).toBe(sharedGlyph(DOCX_MIME));
    expect(glyph).not.toBe(sharedGlyph("text/plain"));
  });

  test("a Bates citation draws the shared PDF glyph", () => {
    const view = renderChip(toChatSourceCitationHref(TARGETS["pdf-bates"]));
    expect(chipGlyph(view.container)).toBe(sharedGlyph(PDF_MIME));
  });

  test("a #folio block citation draws the shared Word glyph", () => {
    expect(isFolioBlockId("seq-0064")).toBe(true);
    const view = renderChip("#folio:seq-0064");
    expect(chipGlyph(view.container)).toBe(sharedGlyph(DOCX_MIME));
  });

  test.each([
    ["xlsx-0123456789abcdef", XLSX_MIME],
    ["pptx-0123456789abcdef", PPTX_MIME],
  ])(
    "an office citation %s draws its format's shared glyph",
    (blockId, mime) => {
      const view = renderChip(
        `#office:${identity.entityId}:${identity.fieldId}:${blockId}`,
        identity.workspaceId,
      );
      expect(chipGlyph(view.container)).toBe(sharedGlyph(mime));
    },
  );

  test.each([
    ...Object.values(TARGETS).map((target) => [
      target.type,
      toChatSourceCitationHref(target),
    ]),
    ["folio", "#folio:seq-0064"],
  ])("the %s citation's file glyph stays decorative", (_kind, href) => {
    const view = renderChip(href);
    expect(
      view.container.querySelector("svg")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});

// Reports every observed element visible as soon as it is observed.
class ImmediatelyVisibleObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds: readonly number[] = [0];
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    const rect = new DOMRect(0, 0, 100, 24);
    this.callback(
      [
        {
          boundingClientRect: rect,
          intersectionRect: rect,
          intersectionRatio: 1,
          isIntersecting: true,
          rootBounds: null,
          target,
          time: performance.now(),
        },
      ],
      this,
    );
  }

  unobserve(): void {}

  disconnect(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

test("an assistant link absent from the source store requests no site icon", async () => {
  const requests: string[] = [];
  const previousFetch = globalThis.fetch;
  const previousObserver = globalThis.IntersectionObserver;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(new Request(input).url);
      return Response.json({ type: "no-icon" });
    },
    { preconnect: () => undefined },
  );
  globalThis.IntersectionObserver = ImmediatelyVisibleObserver;
  try {
    renderChip("https://encoded-data.attacker.example/page");
    await act(async () => {
      await sleep(0);
    });
    expect(requests.filter((url) => url.includes("link-icons"))).toEqual([]);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.IntersectionObserver = previousObserver;
  }
});

test("dot-relative markdown destinations stay clickable with their original href", () => {
  for (const href of ["./document.pdf", "../sources/decision"]) {
    const view = renderChip(href);
    expect(
      view.getByRole("link", { name: CHIP_LABEL }).getAttribute("href"),
    ).toBe(href);
    cleanup();
  }
});
