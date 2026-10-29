import type { ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { PluggableList } from "unified";

import { assertProperty } from "@stll/property-testing";
import {
  markdownLines,
  readFencedBlockAt,
} from "@stll/property-testing/commonmark-code-oracle";

import { unregisterDomEnvironment } from "@/test-dom-environment";

/**
 * Random chat answers for the renderer properties: the Markdown a model
 * streams, including the constructs that break incremental renderers (code
 * fences left open, nested or closed by the wrong fence, reference links whose
 * definition arrives last, footnotes) and the hostile ones a prompt-injected
 * answer can carry (unsafe link schemes, raw HTML).
 */

// Generation budgets bound DOM work per run, independently of product limits.
const MAX_WORDS_PER_INLINE = 3;
const MAX_INLINES_PER_PARAGRAPH = 4;
const MAX_CODE_LINES = 3;
const MAX_BLOCKS = 5;
const MAX_STREAM_CUTS = 8;
const MAX_LIST_ITEMS = 3;
const AT_LEAST_ONE = 1;
const IN_PAGE_LINK_WEIGHT = 4;
/** Text no generated word contains, so a restoration for it never matches. */
const ABSENT_ORIGINAL = "Zephyrine Quandt";

const word = fc.constantFrom(
  "alpha",
  "beta",
  "snake_case",
  "a*b",
  "Čeština",
  "中文",
  "عربى",
  "x1",
);
const words = fc
  .array(word, { minLength: AT_LEAST_ONE, maxLength: MAX_WORDS_PER_INLINE })
  .map((parts) => parts.join(" "));

const UNSAFE_DESTINATIONS: readonly string[] = [
  // oxlint-disable-next-line no-script-url -- adversarial answer text: the renderer must never make it a live link
  "javascript:alert(1)",
  // oxlint-disable-next-line no-script-url -- adversarial answer text: scheme matching must ignore case
  "JaVaScRiPt:alert(1)",
  "data:text/html,<b>x</b>",
  "vbscript:msgbox(1)",
];

// Names a prompt-injected answer could give elements to collide with page ids
// or shadow `window` globals.
const MODEL_NAMES: readonly string[] = ["root", "top", "getElementById"];

const inline = fc.oneof(
  words,
  words.map((text) => `**${text}**`),
  words.map((text) => `*${text}*`),
  words.map((text) => `\`${text}\``),
  words.map((text) => `[${text}](https://example.test/page)`),
  words.map((text) => `[${text}][ref]`),
  fc.constant("https://example.test/auto"),
  fc
    .tuple(words, fc.constantFrom(...UNSAFE_DESTINATIONS))
    .map(([text, destination]) => `[${text}](${destination})`),
  words.map((text) => `<b>${text}</b>`),
  fc.constant('<a href="javascript:alert(1)">raw</a>'),
  fc.constant('<img src="x" onerror="alert(1)">'),
  fc.constant("<script>alert(1)</script>"),
  fc.constant("&lt;b&gt;escaped&lt;/b&gt;"),
  fc.constant("note[^1]"),
  fc
    .constantFrom(...MODEL_NAMES)
    .map((name) => `<span id="${name}">named</span>`),
  fc.constant('<a name="top">anchor</a>'),
  // Weighted so a link and its target often land in different blocks.
  { arbitrary: fc.constant("[jump](#top)"), weight: IN_PAGE_LINK_WEIGHT },
);

const paragraph = fc
  .array(inline, {
    minLength: AT_LEAST_ONE,
    maxLength: MAX_INLINES_PER_PARAGRAPH,
  })
  .map((parts) => parts.join(" "));

const fence = fc.constantFrom("```", "````", "~~~");
const codeLine = fc.oneof(words, fc.constant("```"), fc.constant("~~~"));
const codeBlock = fc
  .record({
    fence,
    language: fc.constantFrom("", "js", "py"),
    lines: fc.array(codeLine, {
      minLength: AT_LEAST_ONE,
      maxLength: MAX_CODE_LINES,
    }),
    close: fc.constantFrom("matching", "missing", "other"),
  })
  .map(({ fence: opener, language, lines, close }) => {
    const otherFence = opener.startsWith("~") ? "```" : "~~~";
    const closers = {
      matching: `\n${opener}`,
      missing: "",
      other: `\n${otherFence}`,
    };
    const closer = closers[close];
    return `${opener}${language}\n${lines.join("\n")}${closer}`;
  });

const block = fc.oneof(
  paragraph,
  fc
    .tuple(fc.constantFrom("#", "##", "###"), words)
    .map(([marks, text]) => `${marks} ${text}`),
  fc
    .array(paragraph, { minLength: AT_LEAST_ONE, maxLength: MAX_LIST_ITEMS })
    .map((items) => items.map((item) => `- ${item}`).join("\n")),
  fc
    .array(words, { minLength: AT_LEAST_ONE, maxLength: MAX_LIST_ITEMS })
    .map((items) =>
      items.map((item, index) => `${index + 1}. ${item}`).join("\n"),
    ),
  codeBlock,
  fc.constant("[ref]: https://example.test/ref"),
  fc.constant("[^1]: footnote text"),
  fc.constant("| a | b |\n| - | - |\n| 1 | 2 |"),
  words.map((text) => `<div>${text}</div>`),
  {
    arbitrary: words.map((text) => `<h2 id="top">${text}</h2>`),
    weight: IN_PAGE_LINK_WEIGHT,
  },
  fc.constant("---"),
);

const chatAnswerArbitrary = fc
  .array(block, { minLength: AT_LEAST_ONE, maxLength: MAX_BLOCKS })
  .map((blocks) => blocks.join("\n\n"));

/** An answer plus the offsets its stream was cut at, ascending and distinct. */
const streamedChatAnswerArbitrary = chatAnswerArbitrary.chain((answer) =>
  fc
    .uniqueArray(fc.integer({ min: 1, max: Math.max(1, answer.length - 1) }), {
      maxLength: MAX_STREAM_CUTS,
    })
    .map((cuts) => ({
      answer,
      prefixes: [
        ...cuts
          .toSorted((left, right) => left - right)
          .map((cut) => answer.slice(0, cut)),
        answer,
      ],
    })),
);

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { MessageResponseImpl } = await import("./message-response");
const { rehypeAnonSpans } = await import("@/components/chat/rehype-anon-spans");
const { ANSWER_ID_PREFIX } =
  await import("@/components/chat/rehype-scope-answer-ids");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

type RenderOptions = {
  isAnimating?: boolean;
  rehypePlugins?: PluggableList;
  sourceOffsets?: boolean;
};

// Anonymized threads add this plugin to every answer and user message. Its
// original never occurs in generated text, so it must leave output unchanged.
const ANON_PLUGINS: PluggableList = [
  [rehypeAnonSpans, [{ placeholder: "[PERSON_1]", original: ABSENT_ORIGINAL }]],
];
const LATE_RESTORATION: PluggableList = [
  [rehypeAnonSpans, [{ placeholder: "[PERSON_2]", original: "alpha" }]],
];
const RENDERER_CONFIGS = [
  { name: "default", options: {} },
  { name: "anonymized", options: { rehypePlugins: ANON_PLUGINS } },
] as const satisfies readonly { name: string; options: RenderOptions }[];

const element = (
  source: string,
  options: RenderOptions,
  client: InstanceType<typeof QueryClient>,
): ReactElement => (
  <QueryClientProvider client={client}>
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <MessageResponseImpl {...options}>{source}</MessageResponseImpl>
    </IntlProvider>
  </QueryClientProvider>
);

/** One mounted answer, re-rendered the way the chat feeds it stream deltas. */
const mountAnswer = async (source: string, options: RenderOptions = {}) => {
  const client = new QueryClient();
  clients.push(client);
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(element(source, options, client));
  });
  if (view === undefined) {
    throw new Error("render did not mount");
  }
  const mounted = view;
  return {
    root: mounted.container,
    update: async (next: string, nextOptions: RenderOptions = options) => {
      await act(async () => {
        mounted.rerender(element(next, nextOptions, client));
      });
    },
    unmount: async () => {
      await act(async () => {
        mounted.unmount();
      });
    },
  };
};

const renderedHtml = async (source: string, options: RenderOptions = {}) => {
  const view = await mountAnswer(source, options);
  const html = view.root.innerHTML;
  await view.unmount();
  return html;
};

const SAFE_HREF = /^(?:https?:|mailto:|tel:|#|\/(?![\\/]))/iu;
const URL_ATTRIBUTES = new Set([
  "action",
  "formaction",
  "href",
  "poster",
  "src",
  "srcset",
  "xlink:href",
]);
const ACTIVE_TAGS = new Set([
  "BASE",
  "EMBED",
  "FORM",
  "FRAME",
  "IFRAME",
  "LINK",
  "META",
  "OBJECT",
  "SCRIPT",
  "STYLE",
]);

/** Everything a hostile answer could turn into executable or navigable DOM. */
const activeContent = (root: Element): string[] =>
  [...root.querySelectorAll("*")].flatMap((node) => {
    const found: string[] = [];
    if (ACTIVE_TAGS.has(node.tagName)) {
      found.push(`<${node.tagName.toLowerCase()}>`);
    }
    // GFM task lists keep inputs, but only as disabled checkboxes.
    if (
      node.tagName === "INPUT" &&
      !(
        node.getAttribute("type") === "checkbox" &&
        node.hasAttribute("disabled")
      )
    ) {
      found.push(`<input ${node.getAttribute("type") ?? ""}>`);
    }
    for (const { name, value } of node.attributes) {
      if (name.toLowerCase().startsWith("on")) {
        found.push(`${name}=${value}`);
      }
      if (
        URL_ATTRIBUTES.has(name.toLowerCase()) &&
        !SAFE_HREF.test(value.trim())
      ) {
        found.push(`${name}=${value}`);
      }
    }
    return found;
  });

/** Ids and names the answer's own raw HTML declares. */
const modelNames = (source: string): Set<string> =>
  new Set(
    Array.from(
      source.matchAll(/\b(?:id|name)="([^"]+)"/gu),
      (match) => match[1] ?? "",
    ),
  );

/** Repeats among ids the renderer generates; a model may repeat its own. */
const duplicateIds = (root: Element, source: string): string[] => {
  const declared = modelNames(source);
  const ids = [...root.querySelectorAll("[id]")].map((node) => node.id);
  return ids.filter(
    (id, index) =>
      ids.indexOf(id) !== index &&
      !declared.has(id.slice(ANSWER_ID_PREFIX.length)),
  );
};

/** Element names in the answer outside its namespace: page collisions. */
const unscopedNames = (root: Element): string[] =>
  [...root.querySelectorAll("[id], [name]")].flatMap((node) =>
    ["id", "name"].flatMap((attribute) => {
      const value = node.getAttribute(attribute);
      return value === null || value.startsWith(ANSWER_ID_PREFIX)
        ? []
        : [`${attribute}=${value}`];
    }),
  );

/**
 * In-page links that miss: a scoped fragment must name an element of the
 * answer, and an unscoped one must not name an element that was scoped.
 */
const brokenFragments = (root: Element): string[] => {
  const named = (fragment: string) =>
    root.querySelector(
      `[id="${CSS.escape(fragment)}"], [name="${CSS.escape(fragment)}"]`,
    );
  return [...root.querySelectorAll('a[href^="#"]')].flatMap((link) => {
    const fragment = decodeURIComponent(
      link.getAttribute("href")?.slice(1) ?? "",
    );
    const broken = fragment.startsWith(ANSWER_ID_PREFIX)
      ? named(fragment) === null
      : named(`${ANSWER_ID_PREFIX}${fragment}`) !== null;
    return broken ? [`#${fragment}`] : [];
  });
};

describe("streamed chat answers", () => {
  test("streamed answers settle to the render of the whole answer", async () => {
    await assertProperty(
      "streamed answers settle to the render of the whole answer",
      fc.asyncProperty(
        streamedChatAnswerArbitrary,
        async ({ answer, prefixes }) => {
          for (const config of RENDERER_CONFIGS) {
            // While the turn runs the chat marks the answer as animating.
            const streaming = { ...config.options, isAnimating: true };
            const view = await mountAnswer(prefixes.at(0) ?? "", streaming);
            for (const prefix of prefixes) {
              await view.update(prefix);
              expect({
                config: config.name,
                prefix,
                active: activeContent(view.root),
              }).toEqual({ config: config.name, prefix, active: [] });
              expect(duplicateIds(view.root, prefix)).toEqual([]);
              expect({ prefix, names: unscopedNames(view.root) }).toEqual({
                prefix,
                names: [],
              });
            }
            // Re-rendering a growing prefix in place leaves no stale nodes behind.
            expect(view.root.innerHTML).toBe(
              await renderedHtml(answer, streaming),
            );
            // The chat settles a finished turn by switching to source offsets;
            // the settled frame is the one a reload of the thread shows.
            const settled = { ...config.options, sourceOffsets: true };
            await view.update(answer, settled);
            expect(view.root.innerHTML).toBe(
              await renderedHtml(answer, settled),
            );
            expect(activeContent(view.root)).toEqual([]);
            expect(unscopedNames(view.root)).toEqual([]);
            expect(brokenFragments(view.root)).toEqual([]);
            // Restorations can arrive after the text (server metadata): the
            // mounted answer must pick up the new plugin set, not keep the old.
            const restored = { ...settled, rehypePlugins: LATE_RESTORATION };
            await view.update(answer, restored);
            expect(view.root.innerHTML).toBe(
              await renderedHtml(answer, restored),
            );
            await view.unmount();
          }
          // Plugins a surface adds must never change what the base chain renders.
          expect(
            await renderedHtml(answer, { rehypePlugins: ANON_PLUGINS }),
          ).toBe(await renderedHtml(answer));
        },
      ),
      { numRuns: 30 },
    );
  });

  test("a code fence closed late, by a longer fence or never keeps the following text out of the code", async () => {
    const cases = [
      { source: "```js\nconst a = 1;\n```\n\nafter", outside: "after" },
      { source: "````\n```\ninner\n```\n````\n\nafter", outside: "after" },
      { source: "```\ncode\n````\n\nafter", outside: "after" },
      { source: "```\ncode\n~~~\nstill code", outside: null },
      { source: "```py\nopen block", outside: null },
    ] as const;
    for (const { source, outside } of cases) {
      const reading = readFencedBlockAt(markdownLines(source), 0);
      // The oracle reads the fixture as one fenced block opening on line 0.
      expect(reading).toBeDefined();
      const view = await mountAnswer("");
      for (let end = 1; end <= source.length; end += 1) {
        await view.update(source.slice(0, end));
      }
      await view.update(source, { sourceOffsets: true });
      const code = view.root.querySelector("pre code");
      const lines = [...(code?.children ?? [])].map((line) => line.textContent);
      expect({ source, code: lines.join("\n") }).toEqual({
        source,
        code: reading?.content ?? "",
      });
      const prose = [...view.root.querySelectorAll("p")].map(
        (node) => node.textContent,
      );
      expect({ source, prose }).toEqual({
        source,
        prose: outside === null ? [] : [outside],
      });
      await view.unmount();
    }
  });

  test("a reference definition streamed last resolves the earlier reference once the answer settles", async () => {
    const source =
      "See [the act][act] first.\n\nMore context.\n\n[act]: https://example.test/act";
    const view = await mountAnswer("");
    for (let end = 1; end <= source.length; end += 1) {
      await view.update(source.slice(0, end));
    }
    await view.update(source, { sourceOffsets: true });
    const links = [...view.root.querySelectorAll("a")].map((link) => ({
      href: link.getAttribute("href"),
      text: link.textContent,
    }));
    expect(links).toEqual([
      { href: "https://example.test/act", text: "the act" },
    ]);
    expect(view.root.textContent).not.toContain("[act]");
  });

  test("repeated headings and footnote references keep element ids unique", async () => {
    const source =
      "# Terms\n\nFirst[^1] and again[^1].\n\n# Terms\n\n## Terms\n\n[^1]: Source.";
    for (const sourceOffsets of [false, true]) {
      const view = await mountAnswer(source, { sourceOffsets });
      expect(view.root.querySelectorAll("h1")).toHaveLength(2);
      // The fixture reaches the id-producing path: footnotes carry ids.
      expect(view.root.querySelectorAll("[id]").length).toBeGreaterThan(0);
      expect(duplicateIds(view.root, source)).toEqual([]);
      await view.unmount();
    }
  });

  test("names from raw HTML stay inside the answer and in-page links still resolve", async () => {
    const source = [
      '<h2 id="root">Heading</h2>',
      'Jump to [the heading](#root). <img name="getElementById" alt="picture"> <a name="x">anchor</a>',
      "Claim[^1] and again[^1].",
      "[^1]: Source.",
    ].join("\n\n");
    for (const config of RENDERER_CONFIGS) {
      for (const sourceOffsets of [false, true]) {
        const view = await mountAnswer(source, {
          ...config.options,
          sourceOffsets,
        });
        const label = { config: config.name, sourceOffsets };
        expect({ ...label, names: unscopedNames(view.root) }).toEqual({
          ...label,
          names: [],
        });
        // The page's own lookups and globals cannot reach answer elements.
        expect(document.querySelector("#root")).toBeNull();
        expect(document.querySelectorAll("[name='x']")).toHaveLength(0);
        expect(
          document.querySelectorAll("[name='getElementById']"),
        ).toHaveLength(0);
        expect(typeof document.getElementById).toBe("function");
        // The fixture reaches the naming path: the heading keeps a scoped id.
        expect(
          view.root.querySelector(`h2[id="${ANSWER_ID_PREFIX}root"]`)
            ?.textContent,
        ).toBe("Heading");
        if (sourceOffsets) {
          // Settled answers parse as one document, so links cross blocks.
          const fragments = [...view.root.querySelectorAll('a[href^="#"]')].map(
            (link) => link.getAttribute("href"),
          );
          expect(fragments).toEqual([
            `#${ANSWER_ID_PREFIX}root`,
            `#${ANSWER_ID_PREFIX}fn-1`,
            `#${ANSWER_ID_PREFIX}fn-1`,
            `#${ANSWER_ID_PREFIX}fnref-1`,
            `#${ANSWER_ID_PREFIX}fnref-1-2`,
          ]);
          expect({
            ...label,
            broken: brokenFragments(view.root),
          }).toEqual({
            ...label,
            broken: [],
          });
        }
        await view.unmount();
      }
    }
  });
});

describe("code block actions while an answer streams", () => {
  test("an incomplete block holds its actions until the stream settles", async () => {
    const open = "Example:\n\n```js\nconst total = 1;";
    const view = await mountAnswer(open, { isAnimating: true });
    const renderedBlock = () =>
      view.root.querySelector<HTMLElement>('[data-streamdown="code-block"]');
    const actions = () => [
      ...view.root.querySelectorAll(
        '[data-streamdown="code-block-actions"] button',
      ),
    ];
    expect(renderedBlock()?.dataset["incomplete"]).toBe("true");
    expect(actions().length).toBeGreaterThan(0);
    expect(actions().every((button) => button.hasAttribute("disabled"))).toBe(
      true,
    );
    // The stream ends with the same text: only the streaming flag changes.
    await view.update(open, { isAnimating: false });
    expect(renderedBlock()?.dataset["incomplete"]).toBeUndefined();
    expect(actions().length).toBeGreaterThan(0);
    expect(actions().some((button) => button.hasAttribute("disabled"))).toBe(
      false,
    );
  });
});

describe("hostile answer content", () => {
  const linkCases = [
    ...UNSAFE_DESTINATIONS.map((destination) => ({
      name: `inline link to ${destination.slice(0, destination.indexOf(":"))}`,
      source: `Open [the label](${destination}) now.`,
    })),
    {
      name: "entity-obfuscated scheme",
      source: "Open [the label](java&#x09;script:alert(1)) now.",
    },
    {
      name: "reference definition",
      source: "Open [the label][x] now.\n\n[x]: javascript:alert(1)",
    },
    {
      name: "autolink",
      source: "Open <javascript:alert(1)> now, the label.",
    },
    {
      name: "raw anchor",
      source: 'Open <a href="javascript:alert(1)">the label</a> now.',
    },
  ] as const;

  for (const { name, source } of linkCases) {
    test(`an unsafe ${name} never renders as a live link`, async () => {
      for (const config of RENDERER_CONFIGS) {
        for (const sourceOffsets of [false, true]) {
          const root = document.createElement("div");
          // safe-html: the renderer's own output, re-parsed into a detached node for inspection.
          root.innerHTML = await renderedHtml(source, {
            ...config.options,
            sourceOffsets,
          });
          expect({ config: config.name, active: activeContent(root) }).toEqual({
            config: config.name,
            active: [],
          });
          expect(root.querySelectorAll("a")).toHaveLength(0);
          // The label stays readable: the link is neutralized, not swallowed.
          expect(root.textContent).toContain("the label");
        }
      }
    });
  }

  test("raw HTML from the model is sanitized under every plugin set", async () => {
    const source = [
      "<b>kept</b> <img src=x onerror=alert(1)> <script>alert(1)</script>",
      '<iframe src="https://example.test"></iframe> <svg onload=alert(1)></svg>',
      '<form action="javascript:alert(1)"><input name=q></form> <style>*{}</style>',
    ].join("\n\n");
    for (const config of RENDERER_CONFIGS) {
      const view = await mountAnswer(source, config.options);
      expect({ config: config.name, active: activeContent(view.root) }).toEqual(
        {
          config: config.name,
          active: [],
        },
      );
      // Safe formatting HTML is parsed, never shown as source text.
      expect(view.root.querySelector("b")?.textContent).toBe("kept");
      expect(view.root.textContent).not.toContain("<");
      await view.unmount();
    }
  });

  test("HTML a user typed renders as inert text", async () => {
    // The composer stores typed text as escaped HTML inside its own paragraphs.
    const source =
      "<p>&lt;script&gt;alert(1)&lt;/script&gt; and &lt;b&gt;bold&lt;/b&gt;</p>";
    for (const config of RENDERER_CONFIGS) {
      const view = await mountAnswer(source, config.options);
      expect({ config: config.name, text: view.root.textContent }).toEqual({
        config: config.name,
        text: "<script>alert(1)</script> and <b>bold</b>",
      });
      expect(view.root.querySelector("script, b")).toBeNull();
      await view.unmount();
    }
  });
});
