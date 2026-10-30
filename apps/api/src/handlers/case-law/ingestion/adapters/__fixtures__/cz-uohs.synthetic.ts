/**
 * Synthetic ÚOHS test inputs: an export with one record per known
 * collection plus one from an unknown department, and a one-page text PDF.
 * They name no real natural persons. They are source, not captures, so they
 * live in code rather than beside the hash-guarded captured fixtures.
 */
export const CZ_UOHS_SYNTHETIC_LISTING = {
  "@context": "https://uohs.gov.cz/opendata/kontexty/rozhodnuti.jsonld",
  rozhodnutí: [
    {
      typ: ["Digitální objekt", "Rozhodnutí ÚOHS"],
      iri: "https://uohs.gov.cz/cs/verejne-zakazky/sbirky-rozhodnuti/detail-90001.html",
      věc: {
        cs: "Fiktivní veřejná zakázka na dodávku techniky",
      },
      číslo_jednací: "90001/2026/163",
      spisová_značka: "R0901/2026/VZ",
      instance: ["https://uohs.gov.cz/cs/ciselniky/instance/2.html"],
      odbor: ["https://uohs.gov.cz/cs/verejne-zakazky.html"],
      datum_právní_moci: {
        typ: "Časový okamžik",
        datum: "2026-10-12",
      },
      účastník: [
        {
          typ: "Osoba",
          jméno: {
            cs: "obec Fiktivní Lhota",
          },
        },
      ],
      typ_řízení: ["https://uohs.gov.cz/cs/ciselniky/typy-rizeni/8.html"],
      typ_rozhodnutí: [
        "https://uohs.gov.cz/cs/ciselniky/typy-rozhodnuti/36.html",
      ],
      dokument: [
        {
          typ: "Digitální objekt",
          url: "https://uohs.gov.cz/download/sbirky_rozhodnuti/dokumenty/synthetic.pdf",
        },
      ],
    },
    {
      typ: ["Digitální objekt", "Rozhodnutí ÚOHS"],
      iri: "https://uohs.gov.cz/cs/hospodarska-soutez/sbirky-rozhodnuti/detail-90002.html",
      věc: {
        cs: "Fiktivní spojení soutěžitelů",
      },
      číslo_jednací: "90002/2026/500",
      spisová_značka: "S0216/2022/KD",
      instance: [],
      odbor: ["https://uohs.gov.cz/cs/hospodarska-soutez.html"],
      účastník: [],
      typ_řízení: [],
      typ_rozhodnutí: [],
      dokument: [],
    },
    {
      typ: ["Digitální objekt", "Rozhodnutí ÚOHS"],
      iri: "https://uohs.gov.cz/cs/verejna-podpora/sbirky-rozhodnuti/detail-90003.html",
      věc: {
        cs: "Fiktivní veřejná podpora",
      },
      číslo_jednací: "90003/2026/500",
      spisová_značka: "S0903/2026/VP",
      instance: [],
      odbor: ["https://uohs.gov.cz/cs/verejna-podpora.html"],
      datum_právní_moci: {
        typ: "Časový okamžik",
        datum: "2026-10-13",
      },
      účastník: [],
      typ_řízení: [],
      typ_rozhodnutí: [],
      dokument: [],
    },
    {
      typ: ["Digitální objekt", "Rozhodnutí ÚOHS"],
      iri: "https://uohs.gov.cz/cs/nezname/detail-90004.html",
      věc: {
        cs: "Fiktivní neznámá sbírka",
      },
      číslo_jednací: "90004/2026/500",
      spisová_značka: "S0904/2026/XX",
      instance: [],
      odbor: ["https://uohs.gov.cz/cs/nezname.html"],
      účastník: [],
      typ_řízení: [],
      typ_rozhodnutí: [],
      dokument: [],
    },
  ],
};

const SYNTHETIC_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5k" +
  "b2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFs1IDAgUl0gL0NvdW50IDEgPj4K" +
  "ZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9u" +
  "dCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nID4+CmVuZG9iago0IDAg" +
  "b2JqCjw8IC9MZW5ndGggMTIwID4+CnN0cmVhbQpCVCAvRjEgMTYgVGYgNTYgNzQwIFRkIChT" +
  "eW50aGV0aWMgVU9IUyBkZWNpc2lvbikgVGogMCAtMjggVGQgL0YxIDExIFRmIChGaWt0aXZu" +
  "aSByb3pob2RudXRpLiBbb2JjaG9kbmkgdGFqZW1zdHZpXSkgVGogRVQKZW5kc3RyZWFtCmVu" +
  "ZG9iago1IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFsw" +
  "IDAgNjEyIDc5Ml0gL0NvbnRlbnRzIDQgMCBSIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0Yx" +
  "IDMgMCBSID4+ID4+ID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAw" +
  "MDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAw" +
  "IG4gCjAwMDAwMDAyMTIgMDAwMDAgbiAKMDAwMDAwMDM4MyAwMDAwMCBuIAp0cmFpbGVyCjw8" +
  "IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjUwOQolJUVPRgo=";

/** A one-page PDF whose text layer reads "Fiktivni rozhodnuti". */
export const czUohsSyntheticPdf = (): Uint8Array =>
  Uint8Array.from(
    atob(SYNTHETIC_PDF_BASE64),
    (char) => char.codePointAt(0) ?? 0,
  );