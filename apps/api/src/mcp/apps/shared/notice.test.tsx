import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { createTranslator, IntlProvider } from "use-intl";

import MCP_APP_MESSAGES from "@stll/api-contract/mcp-app-messages";
import { normalizeUnicode } from "@stll/text-normalize";

import type { SearchResults } from "./contracts";
import { AppNotice, SearchNotice } from "./notice";
import { searchNoticeDetails } from "./notice.logic";

type ToolWarning = Extract<
  SearchResults,
  { results: unknown }
>["searches"][number]["warnings"][number];

const warnings = [
  {
    code: "function_words_optional",
    droppedFunctionWords: ["za", "při"],
    message: "MODEL ONLY",
    hint: "Pass strict: true",
  },
  {
    code: "filter_read",
    filter: "court",
    courtAliases: [{ input: "NS", resolved: "Nejvyšší soud" }],
    message: "MODEL ONLY",
    hint: "Pass court",
  },
  {
    code: "function_words_optional",
    droppedFunctionWords: ["při", "se"],
    message: "MODEL ONLY",
    hint: "Pass strict: true",
  },
  {
    code: "filter_read",
    filter: "court",
    courtAliases: [
      { input: "ÚS", resolved: "Ústavní soud" },
      { input: "NS", resolved: "Nejvyšší soud" },
    ],
    message: "MODEL ONLY",
    hint: "Pass court",
  },
] as const satisfies readonly ToolWarning[];

const t = createTranslator({ locale: "cs", messages: MCP_APP_MESSAGES.cs });

describe("compact search notices", () => {
  test("merges alias notes before deduplicated query words in one closed disclosure", () => {
    const details = searchNoticeDetails(warnings, t);
    expect(details).toEqual([
      "Hledáno NS jako Nejvyšší soud, ÚS jako Ústavní soud",
      "Vynechaná výplňová slova: za, při, se",
    ]);
    const markup = renderToStaticMarkup(<AppNotice details={details} />);
    expect(markup.match(/<details/gu)).toHaveLength(1);
    expect(markup.match(/<summary/gu)).toHaveLength(1);
    expect(markup).not.toContain(" open=");
    expect(markup).toContain("truncate");
    expect(markup).toContain("<ul");
  });

  test("identity aliases are ignored after canonical and case-insensitive comparison", () => {
    const decomposed = normalizeUnicode("Ústavní soud", "NFD");
    expect(decomposed).not.toBe("Ústavní soud");
    const aliases = [
      {
        code: "filter_read",
        filter: "court",
        courtAliases: [
          { input: "Nejvyšší soud", resolved: "Nejvyšší soud" },
          { input: decomposed.toUpperCase(), resolved: "Ústavní soud" },
        ],
        message: "MODEL ONLY",
        hint: "MODEL ONLY",
      },
    ] as const satisfies readonly ToolWarning[];
    expect(searchNoticeDetails(aliases, t)).toEqual([]);
    expect(
      searchNoticeDetails(
        [
          {
            ...aliases[0],
            courtAliases: [{ input: "Ustavní soud", resolved: "Ústavní soud" }],
          },
        ],
        t,
      ),
    ).toEqual(["Hledáno Ustavní soud jako Ústavní soud"]);
  });

  test("German alias summaries introduce the pair without repeating its connector", () => {
    const translate = createTranslator({
      locale: "de",
      messages: MCP_APP_MESSAGES.de,
    });
    expect(searchNoticeDetails([warnings[1]], translate)).toEqual([
      "Gesucht: NS als Nejvyšší soud",
    ]);
  });

  test("adding duplicate warnings is a fixed point", () => {
    expect(searchNoticeDetails([...warnings, ...warnings], t)).toEqual(
      searchNoticeDetails(warnings, t),
    );
  });

  test("empty warnings and model-only guidance render nothing", () => {
    const guidance = [
      {
        code: "many_required_terms",
        message: "MODEL ONLY",
        hint: "Pass other words",
      },
    ] as const satisfies readonly ToolWarning[];
    expect(searchNoticeDetails([], t)).toEqual([]);
    expect(searchNoticeDetails(guidance, t)).toEqual([]);
    expect(renderToStaticMarkup(<AppNotice details={[]} />)).toBe("");
  });

  test("every locale summarizes structured fields without rendering model wording", () => {
    for (const [locale, messages] of Object.entries(MCP_APP_MESSAGES)) {
      const translator = createTranslator({ locale, messages });
      const details = searchNoticeDetails(warnings, translator);
      expect(details).toHaveLength(2);
      expect(details[0]).toContain("NS");
      expect(details[1]).toContain("za, při, se");
      const markup = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <SearchNotice warnings={warnings} />
        </IntlProvider>,
      );
      expect(markup).not.toContain("MODEL ONLY");
      expect(markup).not.toContain("Pass strict");
      expect(markup).not.toContain("Pass court");
      expect(markup.match(/<details/gu)).toHaveLength(1);
    }
  });

  test("empty-result and ignored-filter warnings are actionable user data", () => {
    const results = [
      {
        code: "filter_dropped",
        filter: "court",
        received: "Unknown court",
        message: "MODEL ONLY",
        hint: "MODEL ONLY",
      },
      {
        code: "no_hits_filtered",
        filters: ["court", "dateFrom"],
        message: "MODEL ONLY",
        hint: "MODEL ONLY",
      },
      { code: "no_hits", message: "MODEL ONLY", hint: "MODEL ONLY" },
    ] as const satisfies readonly ToolWarning[];
    expect(searchNoticeDetails(results, t)).toEqual([
      "Vynechaný filtr soudu: Unknown court",
      "Žádné výsledky s filtry: Soud, Od",
      "Žádná odpovídající rozhodnutí",
    ]);
  });
});
