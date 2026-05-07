import type { ChatMessage } from "@stll/api/types";

const externalMcpDocumentUrl =
  "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068";

const externalMcpSearchHit = {
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
  url: externalMcpDocumentUrl,
};

export const externalMcpSearchResponseFixture = {
  content: [
    {
      text: JSON.stringify({
        query: "sentencia tribunal constitucional proteccion datos personales",
        hits: [externalMcpSearchHit],
        total_hits: 10,
        elapsed_ms: 1807,
      }),
      type: "text",
    },
  ],
  isError: false,
} as const;

const externalMcpGetDocument = {
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
  url: externalMcpDocumentUrl,
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

export const externalMcpGetDocumentObservedShape = {
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

export const externalMcpGetDocumentResponseFixture = {
  content: [
    {
      text: JSON.stringify(externalMcpGetDocument),
      type: "text",
    },
  ],
  isError: false,
} as const;

export const externalMcpCitedAssistantMessageFixture = {
  id: "mock-external-mcp-cited-assistant",
  role: "assistant",
  parts: [
    {
      type: "step-start",
    },
    {
      type: "dynamic-tool",
      toolName: "mcp__externallegal__get_document",
      toolCallId: "tool_mock_external_mcp_get_document_105_2022",
      state: "output-available",
      input: {
        source: "ES/ConstitutionalCourt",
        source_id: "ECLI:ES:TC:2022:105",
      },
      output: externalMcpGetDocumentResponseFixture,
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
        "The Tribunal Constitucional decision recognizes the case as a recurso de amparo decided by the Pleno, with a full document record available from the external MCP server.",
        "",
        "The relevant citation is [SENTENCIA 105/2022, de 13 de septiembre](https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068).",
      ].join("\n"),
    },
  ],
} satisfies ChatMessage;
