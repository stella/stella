import { Tokenizer } from "htmlparser2";
import { Buffer } from "node:buffer";

export const PL_KIO_HTML_BUDGET = {
  maxBytes: 2 * 1024 * 1024,
  maxMarkupTokens: 20_000,
} as const;

export const PL_KIO_DOCUMENT_REJECTION = {
  OVERSIZED: "oversized",
  MARKUP_BUDGET_EXCEEDED: "markup-budget-exceeded",
} as const;

/** Count tag and attribute-name tokens without constructing DOM or attribute maps. */
export const inspectPlKioHtmlBudget = (html: string) => {
  if (Buffer.byteLength(html, "utf-8") > PL_KIO_HTML_BUDGET.maxBytes) {
    return { type: PL_KIO_DOCUMENT_REJECTION.OVERSIZED } as const;
  }
  let tokens = 0;
  const countToken = () => {
    tokens += 1;
    if (tokens > PL_KIO_HTML_BUDGET.maxMarkupTokens) {
      tokenizer.pause();
    }
  };
  const ignore = () => undefined;
  const tokenizer = new Tokenizer(
    { decodeEntities: false },
    {
      onattribname: countToken,
      onopentagname: countToken,
      onclosetag: countToken,
      oncomment: countToken,
      oncdata: countToken,
      ondeclaration: countToken,
      onprocessinginstruction: countToken,
      onattribdata: ignore,
      onattribentity: ignore,
      onattribend: ignore,
      onopentagend: ignore,
      onselfclosingtag: ignore,
      ontext: ignore,
      ontextentity: ignore,
      onend: ignore,
    },
  );
  tokenizer.write(html);
  if (tokens <= PL_KIO_HTML_BUDGET.maxMarkupTokens) {
    tokenizer.end();
  }
  if (tokens > PL_KIO_HTML_BUDGET.maxMarkupTokens) {
    return {
      type: PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED,
    } as const;
  }
  return { type: "accepted" } as const;
};
