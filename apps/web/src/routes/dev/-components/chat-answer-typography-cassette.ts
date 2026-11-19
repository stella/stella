import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { decisionReferenceHref } from "@/components/references/reference.logic";

// One finished turn that uses every block an answer is built from: a title the
// model should not have written, section headings, nested bullet and numbered
// lists, a table, a quotation and an inline decision citation. Typography
// changes are judged against this answer; the cited decision is a seeded one,
// so the chip resolves on a seeded stack.
const CITED_DECISION_HREF = decisionReferenceHref(
  "a1220b81-31c2-53c8-8eb1-3c0b61bf7658",
);

export const CHAT_ANSWER_TYPOGRAPHY_CASSETTE = [
  {
    createdAt: new Date("2026-11-18T09:12:04.000Z"),
    edited: false,
    id: "01a18a40-1c00-7a00-8a00-000000000001",
    role: "user",
    revision: 0,
    parts: [
      {
        type: "text",
        content:
          "Může pronajímatel vypovědět nájem bytu, když nájemce opakovaně platí nájemné pozdě? Jaká je výpovědní doba?",
      },
    ],
  },
  {
    createdAt: new Date("2026-11-18T09:12:31.000Z"),
    edited: false,
    id: "01a18a40-1c00-7a00-8a00-000000000002",
    metadata: { turnTiming: { status: "finished", durationMs: 27_000 } },
    parts: [
      {
        type: "text",
        content: [
          "# Výpověď nájmu bytu pro pozdní platby",
          "",
          "**Stručně:** Ano. Opakované pozdní placení nájemného může být hrubým porušením povinnosti nájemce, pokud dluh dosáhne alespoň trojnásobku měsíčního nájemného. Pronajímatel pak může vypovědět nájem s tříměsíční výpovědní dobou, a v nejzávažnějších případech i bez ní.",
          "",
          "## Kdy může pronajímatel vypovědět",
          "",
          `Soudy posuzují pozdní platby podle jejich četnosti a výše dluhu. Shodně to vykládá Nejvyšší soud v rozsudku [22 Cdo 102/2018](${CITED_DECISION_HREF}), podle kterého rozhoduje celkový obraz platební kázně, ne jedna opožděná platba.`,
          "",
          "- **Hrubé porušení povinnosti:**",
          "  - dluh na nájemném ve výši alespoň trojnásobku měsíčního nájemného,",
          "  - opakované prodlení, které pronajímatel písemně vytkl.",
          "- **Odsouzení za trestný čin** vůči pronajímateli nebo jeho domácnosti.",
          "- **Byt je třeba vyklidit** z důvodu veřejného zájmu.",
          "",
          "### Výpovědní doba",
          "",
          "1. Výpověď musí mít písemnou formu a dojít nájemci.",
          "2. Doba běží od prvního dne měsíce následujícího po doručení.",
          "   1. U výpovědi bez výpovědní doby musí pronajímatel nájemce nejprve vyzvat k nápravě.",
          "   2. Výzva musí uvést, v čem porušení spočívá.",
          "3. Nájemce může do dvou měsíců podat žalobu na přezkoumání výpovědi.",
          "",
          "| Důvod výpovědi | Výpovědní doba |",
          "| --- | --- |",
          "| Hrubé porušení povinnosti | 3 měsíce |",
          "| Zvlášť závažné porušení | bez výpovědní doby |",
          "",
          "> Pronajímatel nemůže vypovědět nájem jen proto, že nájemce zaplatil jednou o několik dní později.",
          "",
          "## Doporučený postup",
          "",
          "Nejprve nájemce písemně upozorněte na dluh a stanovte lhůtu k úhradě. Teprve když dluh trvá, doručte výpověď s uvedením důvodu a poučením o právu podat žalobu.",
        ].join("\n"),
      },
    ],
    revision: 0,
    role: "assistant",
  },
] satisfies readonly PersistedChatMessage[];
