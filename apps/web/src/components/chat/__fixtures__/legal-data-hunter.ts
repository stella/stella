import type { ChatMessage } from "@stll/api/types";

const legalDataHunterDocumentUrl =
  "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068";

const legalDataHunterSearchHit = {
  source: "ES/ConstitutionalCourt",
  source_id: "ECLI:ES:TC:2022:105",
  score: 0.615_528_226,
  country: "ES",
  court: "Tribunal Constitucional",
  court_tier: 1,
  date: "2022-09-13",
  language: "es",
  title: "SENTENCIA 105/2022, de 13 de septiembre",
  snippet:
    "El Pleno del Tribunal Constitucional, compuesto por el magistrado don Pedro Jose Gonzalez-Trevijano Sanchez, presidente; los magistrados don Juan Antonio Xiol Rios, don Santiago Martinez-Vares Garcia, don Antonio Narvaez Rodriguez, don Ricardo Enriquez Sancho y don Candido Conde-Pumpido Touron; la m",
  url: legalDataHunterDocumentUrl,
};

export const legalDataHunterSearchResponseFixture = {
  content: [
    {
      text: JSON.stringify({
        query: "sentencia tribunal constitucional proteccion datos personales",
        hits: [legalDataHunterSearchHit],
        total_hits: 10,
        elapsed_ms: 1807,
      }),
      type: "text",
    },
  ],
  isError: false,
} as const;

const legalDataHunterGetDocument = {
  source_id: "ECLI:ES:TC:2022:105",
  source: "ES/ConstitutionalCourt",
  title: "SENTENCIA 105/2022, de 13 de septiembre",
  text: [
    "El Pleno del Tribunal Constitucional, compuesto por el magistrado don Pedro Jose Gonzalez-Trevijano Sanchez, presidente; los magistrados don Juan Antonio Xiol Rios, don Santiago Martinez-Vares Garcia, don Antonio Narvaez Rodriguez, don Ricardo Enriquez Sancho y don Candido Conde-Pumpido Touron; la magistrada dona Maria Luisa Balaguer Callejon; los magistrados don Ramon Saez Valcarcel y don Enrique Arnaldo Alcubilla, y las magistradas dona Concepcion Espejel Jorquera y dona Inmaculada Montalban Huertas, ha pronunciado",
    "EN NOMBRE DEL REY",
    "la siguiente",
    "SENTENCIA",
    "En el recurso de amparo num. 229-2021, promovido por don M.J.L., contra la providencia de la Seccion Primera de la Sala de lo Contencioso-Administrativo del Tribunal Supremo, de 19 de noviembre de 2020.",
  ].join("\n\n"),
  url: legalDataHunterDocumentUrl,
  date: "2022-09-13",
  country: "ES",
  language: "es",
  court: "Tribunal Constitucional",
  chamber: "Pleno",
  jurisdiction: null,
  ecli: "ECLI:ES:TC:2022:105",
  case_number: "Recurso de amparo 229-2021",
  decision_type: "SENTENCIA",
  court_tier: 1,
  summary: null,
  data_type: "case_law",
};

export const legalDataHunterGetDocumentObservedShape = {
  mcpWrapperKeys: ["content", "isError"],
  contentTextChars: 120_159,
  documentTextChars: 119_202,
  documentShape: {
    source_id: "string",
    source: "string",
    title: "string",
    text: "string",
    url: "string",
    date: "string",
    country: "string",
    language: "string",
    court: "string",
    chamber: "string",
    jurisdiction: "null",
    ecli: "string",
    case_number: "string",
    decision_type: "string",
    court_tier: "number",
    summary: "null",
    data_type: "string",
  },
} as const;

export const legalDataHunterGetDocumentResponseFixture = {
  content: [
    {
      text: JSON.stringify(legalDataHunterGetDocument),
      type: "text",
    },
  ],
  isError: false,
} as const;

export const legalDataHunterCitedAssistantMessageFixture = {
  id: "mock-legal-data-hunter-cited-assistant",
  role: "assistant",
  parts: [
    {
      type: "step-start",
    },
    {
      type: "dynamic-tool",
      toolName: "mcp__legaldatahunter__get_document",
      toolCallId: "tool_mock_legaldatahunter_get_document_105_2022",
      state: "output-available",
      input: {
        source: "ES/ConstitutionalCourt",
        source_id: "ECLI:ES:TC:2022:105",
      },
      output: legalDataHunterGetDocumentResponseFixture,
      callProviderMetadata: {
        mcp: {
          name: "ai-sdk-mcp-client",
        },
      },
      resultProviderMetadata: {
        mcp: {
          name: "ai-sdk-mcp-client",
        },
      },
    },
    {
      type: "text",
      state: "done",
      text: [
        "The Tribunal Constitucional decision recognizes the case as a recurso de amparo decided by the Pleno, with a full document record available from Legal Data Hunter.",
        "",
        "The relevant citation is [SENTENCIA 105/2022, de 13 de septiembre](https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068).",
      ].join("\n"),
    },
  ],
} satisfies ChatMessage;
