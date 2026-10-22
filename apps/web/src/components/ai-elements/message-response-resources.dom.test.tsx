import type { ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { DetachedWindowAPI } from "happy-dom";
import type { Element as HastElement, Root } from "hast";
import type { PluggableList } from "unified";

import type { MessageResponseProps } from "@/components/ai-elements/message-response";
import { unregisterDomEnvironment } from "@/test-dom-environment";

/**
 * Rendering an answer never makes the browser issue a request on its own.
 *
 * happy-dom loads images, style sheets, scripts and frames here the way a
 * browser would, and every request it or the page makes is recorded instead of
 * sent: the window's fetch interceptor, `fetch`, `XMLHttpRequest`, image
 * `src`/`srcset` writes and resource attributes set on any element. Each case
 * is one way Markdown or HTML in an answer can name a remote resource.
 */

const requests: string[] = [];
// The subset happy-dom's own resource loader started.
const loaderRequests: string[] = [];
const insertedResources: string[] = [];

const isOutbound = (url: string): boolean => !/^(?:data|blob):/iu.test(url);
const recordRequest = (url: string) => {
  if (isOutbound(url)) {
    requests.push(url);
  }
};
const recordLoaderRequest = (url: string) => {
  recordRequest(url);
  if (isOutbound(url)) {
    loaderRequests.push(url);
  }
};

GlobalRegistrator.register({
  url: "http://localhost:3000/chat",
  settings: {
    enableCSSFileLoading: true,
    enableImageFileLoading: true,
    enableIframePageLoading: true,
    fetch: {
      interceptor: {
        beforeAsyncRequest: async ({ request, window }) => {
          recordLoaderRequest(request.url);
          return new window.Response(null, { status: 204 });
        },
        beforeSyncRequest: ({ request, window }) => {
          recordLoaderRequest(request.url);
          return {
            status: 204,
            statusText: "No Content",
            ok: true,
            url: request.url,
            redirected: false,
            headers: new window.Headers(),
            body: null,
          };
        },
      },
    },
  },
});

const windowApi: unknown = Reflect.get(globalThis, "happyDOM");
const happyDom =
  windowApi instanceof DetachedWindowAPI
    ? windowApi
    : panic("The DOM test environment must expose the happy-dom window API");

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    recordRequest(input instanceof Request ? input.url : String(input));
    return Response.json(null);
  },
  { preconnect: () => undefined },
);

const originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function open(
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
) {
  recordRequest(String(url));
  Reflect.apply(originalOpen, this, [method, "data:,"]);
};

// Attributes that start a load when written, on whatever element.
const LOADING_ATTRIBUTES = new Set([
  "background",
  "data",
  "poster",
  "src",
  "srcset",
  "xlink:href",
]);
const originalSetAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function setAttribute(
  this: Element,
  name: string,
  value: string,
) {
  if (LOADING_ATTRIBUTES.has(name.toLowerCase())) {
    recordRequest(value);
  }
  Reflect.apply(originalSetAttribute, this, [name, value]);
};

/** Records every write of an image source property, then performs it. */
const spyOnImageSource = (property: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    property,
  );
  const getter = descriptor?.get;
  const setter = descriptor?.set;
  if (
    descriptor === undefined ||
    getter === undefined ||
    setter === undefined
  ) {
    return panic(`HTMLImageElement.${property} must be an accessor`);
  }
  Object.defineProperty(HTMLImageElement.prototype, property, {
    ...descriptor,
    get(this: HTMLImageElement): unknown {
      return Reflect.apply(getter, this, []);
    },
    set(this: HTMLImageElement, value: string) {
      recordRequest(value);
      Reflect.apply(setter, this, [value]);
    },
  });
  return { property, descriptor };
};
const imageSourceSetters = [
  spyOnImageSource("src"),
  spyOnImageSource("srcset"),
];

/** Elements that load something by being in the page. */
const RESOURCE_SELECTOR = [
  "audio",
  "base",
  "embed",
  "frame",
  "iframe",
  "img:not([src^='data:image/'])",
  "input[type='image' i]",
  "link",
  "meta",
  "object",
  "picture",
  "portal",
  "script",
  "source",
  "style",
  "track",
  "video",
  "svg image",
  "svg use",
  "svg feImage",
].join(", ");

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) {
        continue;
      }
      for (const element of [
        ...(node.matches(RESOURCE_SELECTOR) ? [node] : []),
        ...node.querySelectorAll(RESOURCE_SELECTOR),
      ]) {
        insertedResources.push(element.outerHTML);
      }
    }
  }
});
observer.observe(document.body, { childList: true, subtree: true });

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { MessageResponseImpl, rehypeNoOutboundResources } =
  await import("@/components/ai-elements/message-response");
const { rehypeAnonSpans } = await import("@/components/chat/rehype-anon-spans");

const clients: InstanceType<typeof QueryClient>[] = [];
/**
 * Unmounts every answer, then drops its queries: an unmounted query's
 * garbage-collection timer would hold `waitUntilComplete` for its full delay.
 */
const unmountAll = async () => {
  await act(async () => {
    cleanup();
  });
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
};

afterEach(async () => {
  await unmountAll();
  requests.length = 0;
  loaderRequests.length = 0;
  insertedResources.length = 0;
});
afterAll(async () => {
  observer.disconnect();
  globalThis.fetch = originalFetch;
  XMLHttpRequest.prototype.open = originalOpen;
  Element.prototype.setAttribute = originalSetAttribute;
  for (const { property, descriptor } of imageSourceSetters) {
    Object.defineProperty(HTMLImageElement.prototype, property, descriptor);
  }
  await unregisterDomEnvironment();
});

/** Mounts `element`, then waits for every load happy-dom started. */
const mount = async (element: ReactElement) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          {element}
        </IntlProvider>
      </QueryClientProvider>,
    );
  });
  await happyDom.waitUntilComplete();
  if (view === undefined) {
    panic("The answer did not mount");
  }
  return view.container;
};

/** Attributes left in the DOM that would load a resource. */
const resourceAttributes = (root: Element): string[] =>
  [...root.querySelectorAll("*")].flatMap((node) =>
    [...node.attributes].flatMap(({ name, value }) => {
      const key = name.toLowerCase();
      const embeddedImage =
        node.tagName === "IMG" &&
        key === "src" &&
        value.startsWith("data:image/");
      const link = node.tagName === "A" && key === "href";
      if (
        (LOADING_ATTRIBUTES.has(key) && !embeddedImage) ||
        key === "action" ||
        key === "formaction" ||
        key === "ping" ||
        (key === "href" && !link) ||
        (key === "style" && /url\(|image-set\(|@import/iu.test(value))
      ) {
        return [`<${node.tagName.toLowerCase()} ${name}="${value}">`];
      }
      return [];
    }),
  );

const NO_LOADS = {
  requests: [],
  insertedResources: [],
  resourceElements: [],
  resourceAttributes: [],
};

const loadsOf = (root: Element) => ({
  requests: [...requests],
  insertedResources: [...insertedResources],
  resourceElements: [...root.querySelectorAll(RESOURCE_SELECTOR)].map(
    (node) => node.outerHTML,
  ),
  resourceAttributes: resourceAttributes(root),
});

const REMOTE = "https://example.test";
const PLAIN_ANSWER = "Plain answer";

// One case per way an answer can name a remote resource.
const CASES = [
  { name: "Markdown image", source: `![Chart](${REMOTE}/chart.png)` },
  {
    name: "reference-style image",
    source: `![Chart][chart]\n\n[chart]: ${REMOTE}/chart.png`,
  },
  {
    name: "HTML image with a source set",
    source: `<img src="${REMOTE}/chart.png" srcset="${REMOTE}/chart-2x.png 2x" alt="Chart">`,
  },
  {
    name: "picture with sources",
    source: `<picture><source srcset="${REMOTE}/chart.webp" type="image/webp"><img src="${REMOTE}/chart.png" alt="Chart"></picture>`,
  },
  {
    name: "video with a poster",
    source: `<video poster="${REMOTE}/poster.png" src="${REMOTE}/clip.mp4"><track src="${REMOTE}/captions.vtt"></video>`,
  },
  {
    name: "audio",
    source: `<audio src="${REMOTE}/clip.mp3" autoplay></audio>`,
  },
  { name: "frame", source: `<iframe src="${REMOTE}/page"></iframe>` },
  {
    name: "link hints",
    source: [
      `<link rel="prefetch" href="${REMOTE}/next">`,
      `<link rel="preload" as="image" href="${REMOTE}/hero.png">`,
      `<link rel="icon" href="${REMOTE}/icon.png">`,
      `<link rel="stylesheet" href="${REMOTE}/theme.css">`,
    ].join("\n"),
  },
  { name: "object", source: `<object data="${REMOTE}/file.pdf"></object>` },
  { name: "embed", source: `<embed src="${REMOTE}/file.pdf">` },
  { name: "script", source: `<script src="${REMOTE}/app.js"></script>` },
  {
    name: "style element",
    source: `<style>@import url("${REMOTE}/a.css"); p { background: url("${REMOTE}/b.png"); }</style>`,
  },
  {
    name: "style attribute",
    source: `<p style="background-image: url('${REMOTE}/c.png')">Styled</p>`,
  },
  {
    name: "background attribute",
    source: `<table background="${REMOTE}/bg.png"><tr><td>Cell</td></tr></table>`,
  },
  {
    name: "image input",
    source: `<input type="image" src="${REMOTE}/button.png" alt="Send">`,
  },
  {
    name: "SVG image",
    source: `<svg><image href="${REMOTE}/d.png"></image><use href="${REMOTE}/sprite.svg#x"></use></svg>`,
  },
  {
    name: "document base and refresh",
    source: `<base href="${REMOTE}/"><meta http-equiv="refresh" content="0;url=${REMOTE}/">`,
  },
  {
    name: "math graphics",
    source: `$$\\includegraphics{${REMOTE}/e.png}$$`,
  },
  {
    name: "data and script links",
    source: [
      "[Data](data:text/html;base64,PGI+eDwvYj4=)",
      "[Run](javascript:void(0))",
    ].join(" "),
  },
  {
    name: "autolinks",
    source: `<${REMOTE}/page> and ${REMOTE}/other and www.example.test`,
  },
] as const satisfies readonly { name: string; source: string }[];

/** A caller plugin that adds remote resources after the sanitizer ran. */
function rehypeAddRemoteImage() {
  return (tree: Root) => {
    const image: HastElement = {
      type: "element",
      tagName: "img",
      properties: { src: `${REMOTE}/added.png`, alt: "Added" },
      children: [],
    };
    const frame: HastElement = {
      type: "element",
      tagName: "iframe",
      properties: { src: `${REMOTE}/added` },
      children: [],
    };
    tree.children.push(image, frame);
  };
}

// Anonymized threads add a plugin to every answer; its original never occurs
// in the corpus, so it changes nothing but the plugin chain.
const ANON_PLUGINS: PluggableList = [
  [rehypeAnonSpans, [{ placeholder: "[PERSON_1]", original: "Zephyrine" }]],
];

const CONFIGS = [
  { name: "streaming", props: {} },
  { name: "settled with source offsets", props: { sourceOffsets: true } },
  { name: "anonymized", props: { rehypePlugins: ANON_PLUGINS } },
  {
    name: "embedded images",
    props: { imagePolicy: { kind: "embedded-data" } },
  },
] as const satisfies readonly {
  name: string;
  props: Omit<MessageResponseProps, "children">;
}[];

describe("answers render without outbound requests", () => {
  test("the recorders observe loads made outside the answer renderer", async () => {
    // The page under test loads images, style sheets and frames: without
    // this, an empty record below would prove nothing.
    const root = await mount(
      <>
        <img alt="Chart" src={`${REMOTE}/chart.png`} />
        <link rel="stylesheet" href={`${REMOTE}/theme.css`} />
        <iframe sandbox="" src={`${REMOTE}/frame`} title="Frame" />
      </>,
    );
    expect([...new Set(loaderRequests)].toSorted()).toEqual([
      `${REMOTE}/chart.png`,
      `${REMOTE}/frame`,
      `${REMOTE}/theme.css`,
    ]);
    expect(loadsOf(root).resourceElements).toHaveLength(3);
  });

  for (const { name, source } of CASES) {
    test(`${name} loads nothing`, async () => {
      for (const config of CONFIGS) {
        const root = await mount(
          <MessageResponseImpl {...config.props}>{source}</MessageResponseImpl>,
        );
        expect({ config: config.name, ...loadsOf(root) }).toEqual({
          config: config.name,
          ...NO_LOADS,
        });
        await unmountAll();
      }
    });
  }

  test("an image shows its description in its place", async () => {
    const source = `Before ![Quarterly chart](${REMOTE}/chart.png) after`;
    const root = await mount(
      <MessageResponseImpl>{source}</MessageResponseImpl>,
    );
    expect(root.textContent).toContain("Before Quarterly chart after");
    expect(root.querySelector("img")).toBeNull();
  });

  test("embedded images render only under the embedded-data policy", async () => {
    const embedded = "data:image/png;base64,iVBORw0KGgo=";
    const source = `![Embedded](${embedded}) ![Remote](${REMOTE}/chart.png)`;
    const shown = await mount(
      <MessageResponseImpl imagePolicy={{ kind: "embedded-data" }}>
        {source}
      </MessageResponseImpl>,
    );
    expect(
      [...shown.querySelectorAll("img")].map((image) => image.src),
    ).toEqual([embedded]);
    expect(shown.textContent).toContain("Remote");
    expect(loadsOf(shown)).toEqual(NO_LOADS);
    await unmountAll();

    const described = await mount(
      <MessageResponseImpl>{source}</MessageResponseImpl>,
    );
    expect(described.querySelector("img")).toBeNull();
    expect(described.textContent).toContain("Embedded");
  });

  test("a caller plugin cannot add a resource after the sanitizer", async () => {
    const root = await mount(
      <MessageResponseImpl rehypePlugins={[rehypeAddRemoteImage]}>
        {PLAIN_ANSWER}
      </MessageResponseImpl>,
    );
    expect(loadsOf(root)).toEqual(NO_LOADS);
    expect(root.textContent).toContain("Added");
  });

  test("the resource pass alone removes what would load", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "picture",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "source",
              properties: { srcSet: `${REMOTE}/chart.webp` },
              children: [],
            },
            {
              type: "element",
              tagName: "img",
              properties: { src: `${REMOTE}/chart.png`, alt: "Chart" },
              children: [],
            },
          ],
        },
        {
          type: "element",
          tagName: "iframe",
          properties: { src: `${REMOTE}/page` },
          children: [],
        },
        {
          type: "element",
          tagName: "p",
          properties: {
            style: `background: url(${REMOTE}/c.png)`,
            background: `${REMOTE}/bg.png`,
          },
          children: [{ type: "text", value: "Styled" }],
        },
      ],
    };
    rehypeNoOutboundResources({ kind: "embedded-data" })(tree);
    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "img",
        properties: { alt: "Chart" },
        children: [],
      },
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [{ type: "text", value: "Styled" }],
      },
    ]);
  });

  test("the resource pass keeps links and ordinary attributes", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "a",
          properties: { href: `${REMOTE}/page`, title: "Page" },
          children: [{ type: "text", value: "Page" }],
        },
        {
          type: "element",
          tagName: "span",
          properties: { className: ["note"], dataSrcStart: "0" },
          children: [{ type: "text", value: "Note" }],
        },
      ],
    };
    rehypeNoOutboundResources({ kind: "alt-text" })(tree);
    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "a",
        properties: { href: `${REMOTE}/page`, title: "Page" },
        children: [{ type: "text", value: "Page" }],
      },
      {
        type: "element",
        tagName: "span",
        properties: { className: ["note"], dataSrcStart: "0" },
        children: [{ type: "text", value: "Note" }],
      },
    ]);
  });
});
