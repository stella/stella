// parser-output-unchanged: HTML loads through @stll/html, which reproduces cheerio.load output; parsed content is unchanged.
import { load as loadSlim } from "cheerio/slim";
import type { CheerioAPI, CheerioOptions } from "cheerio/slim";
import { isDocument } from "domhandler";
import { parse, parseFragment, serializeOuter } from "parse5";
import { adapter } from "parse5-htmlparser2-tree-adapter";

/** Parse strings without loading Cheerio's byte decoders or HTTP client. */
export const load = (
  content: string,
  options?: CheerioOptions | null,
  document = true,
) => {
  if (options?.xml || options?.xmlMode) {
    return loadSlim(content, options, document);
  }

  const parseOptions = {
    ...options,
    treeAdapter: options?.treeAdapter ?? adapter,
    scriptingEnabled: options?.scriptingEnabled !== false,
  };
  const root = document
    ? parse(content, parseOptions)
    : parseFragment(content, parseOptions);
  const $ = loadSlim(root, options, document);
  const slimParse = $.fn._parse;
  const slimRender = $.fn._render;

  // Cheerio uses these hooks for inserted markup and selection serialization too.
  $.fn._parse = function (markup, opts, isDoc, context) {
    if (typeof markup !== "string" || opts._useHtmlParser2) {
      return slimParse.call(this, markup, opts, isDoc, context);
    }
    const parserOptions = {
      ...opts,
      treeAdapter: opts.treeAdapter ?? adapter,
      scriptingEnabled: opts.scriptingEnabled !== false,
    };
    return isDoc
      ? parse(markup, parserOptions)
      : parseFragment(context, markup, parserOptions);
  };
  $.fn._render = function (dom) {
    if (this.options._useHtmlParser2) {
      return slimRender.call(this, dom);
    }
    const nodes = "length" in dom ? Array.from(dom) : [dom];
    return nodes
      .flatMap((node) => (isDocument(node) ? node.children : [node]))
      .map((node) => serializeOuter(node, { treeAdapter: adapter }))
      .join("");
  };
  $.fn._make = new Proxy($.fn._make, {
    apply(
      target,
      receiver: unknown,
      [selector, context]: Parameters<typeof $.fn._make>,
    ) {
      return target.call(
        receiver,
        isMarkup(selector)
          ? parseFragment(selector, parseOptions).children
          : selector,
        isMarkup(context) ? parseFragment(context, parseOptions) : context,
      );
    },
  });

  // Slim's initializer parses markup separately from the instance hooks.
  return new Proxy($, {
    apply(
      target,
      _thisArg,
      [selector, context, scope, opts]: Parameters<CheerioAPI>,
    ) {
      if (opts?.xml || opts?.xmlMode) {
        return target(selector, context, scope, opts);
      }
      const parserOptions = { ...parseOptions, ...opts };
      return target(
        isMarkup(selector)
          ? parseFragment(selector, parserOptions).children
          : selector,
        isMarkup(context) ? parseFragment(context, parserOptions) : context,
        typeof scope === "string" ? parseFragment(scope, parserOptions) : scope,
        opts,
      );
    },
  });
};

// Match Cheerio's distinction between selector text and markup.
const isMarkup = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  const start = value.indexOf("<");
  return (
    start !== -1 &&
    /[a-z!]/iu.test(value.charAt(start + 1)) &&
    value.includes(">", start + 2)
  );
};
