import { describe, expect, test } from "bun:test";

import {
  externalMcpCitedAssistantMessageFixture,
  externalMcpGetDocumentResponseFixture,
  externalMcpSearchResponseFixture,
} from "@/components/chat/__fixtures__/external-mcp";
import { collectExternalSources } from "@/components/chat/source-chips.logic";
import type { ExternalSourceEntry } from "@/components/chat/source-chips.logic";

describe("external source extraction from tool output", () => {
  test("extracts a search-hit source from JSON wrapped in MCP text content", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(externalMcpSearchResponseFixture, sources);

    expect(sources).toHaveLength(1);
    expect(sources.at(0)).toMatchObject({
      provider: "ES/ConstitutionalCourt",
      title: "SENTENCIA 105/2022, de 13 de septiembre",
      url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068",
    });
    expect(sources.at(0)?.snippet).toContain(
      "El Pleno del Tribunal Constitucional",
    );
    expect(sources.at(0)?.text).toBeUndefined();
  });

  test("extracts full document text when get_document returns it", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(externalMcpGetDocumentResponseFixture, sources);

    expect(sources).toHaveLength(1);
    expect(sources.at(0)).toMatchObject({
      provider: "ES/ConstitutionalCourt",
      title: "SENTENCIA 105/2022, de 13 de septiembre",
      url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068",
    });
    expect(sources.at(0)?.text).toContain("EN NOMBRE DEL REY");
    expect(sources.at(0)?.snippet).toBeUndefined();
  });

  test("extracts full source data from a mocked cited assistant message", () => {
    const sources: ExternalSourceEntry[] = [];

    for (const part of externalMcpCitedAssistantMessageFixture.parts) {
      if ("output" in part) {
        collectExternalSources(part.output, sources);
      }
    }

    expect(sources).toHaveLength(1);
    expect(sources.at(0)).toMatchObject({
      provider: "ES/ConstitutionalCourt",
      title: "SENTENCIA 105/2022, de 13 de septiembre",
      url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068",
    });
    expect(sources.at(0)?.text).toContain("recurso de amparo");
    expect(
      externalMcpCitedAssistantMessageFixture.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    ).toContain(
      "[SENTENCIA 105/2022, de 13 de septiembre](https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068)",
    );
  });

  test("extracts decision text from generic sourceUrl plus nested texts output", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(
      {
        caseNumber: "23 Cdo 2351/2021",
        courtCode: "NS",
        sourceUrl: "https://mcp.slv.cz/ECLI:CZ:NS:2021:23.CDO.2351.2021.1",
        texts: {
          _combined:
            "=== justificationText ===\n23 Cdo 2351/2021-281\n\nČESKÁ REPUBLIKA\n\nROZSUDEK\n\nJMÉNEM REPUBLIKY",
        },
      },
      sources,
    );

    expect(sources).toHaveLength(1);
    expect(sources.at(0)).toMatchObject({
      provider: "NS",
      title: "23 Cdo 2351/2021",
      url: "https://mcp.slv.cz/ECLI:CZ:NS:2021:23.CDO.2351.2021.1",
    });
    expect(sources.at(0)?.text).toContain("ČESKÁ REPUBLIKA");
    expect(sources.at(0)?.text).toContain("JMÉNEM REPUBLIKY");
  });

  test("extracts ARES company output as a readable external source", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(
      {
        address: {
          textAddress: "Jankovcova 1522/53, Holešovice, 17000 Praha 7",
        },
        courtFile: {
          court: "Městský soud v Praze",
          insert: "8573",
          section: "B",
        },
        dateEstablished: "2003-08-26",
        ico: "27082440",
        legalForm: "Akciová společnost",
        name: "Alza.cz a.s.",
        registryUrl: "https://ares.gov.cz/ekonomicke-subjekty?ico=27082440",
        shareCapital: "2 000 000 Kč",
        statutoryBodies: [
          {
            members: [
              {
                name: "Aleš Zavoral",
                role: "předseda představenstva",
              },
            ],
            organName: "Představenstvo",
          },
        ],
      },
      sources,
    );

    expect(sources).toHaveLength(1);
    expect(sources.at(0)).toMatchObject({
      title: "Alza.cz a.s.",
      url: "https://ares.gov.cz/ekonomicke-subjekty?ico=27082440",
    });
    expect(sources.at(0)?.text).toContain("Sídlo: Jankovcova");
    expect(sources.at(0)?.text).toContain("Aleš Zavoral");
  });
});
