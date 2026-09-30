import { expect, test } from "bun:test";

import { parseFormexBibliography } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj-formex-bibliography";

test("keeps repeated bibliography and page values in source order", () => {
  const bibliography = parseFormexBibliography(`
    <FORMEX>
      <BIB.JUDGMENT>
        <REF.CASE>C-12/24</REF.CASE>
        <REF.CASE>C-13/24</REF.CASE>
        <AUTHOR>CJ</AUTHOR>
        <AUTHOR>GCEU</AUTHOR>
        <NO.SEQ>4</NO.SEQ>
        <NO.SEQ>5</NO.SEQ>
        <PAGE.FIRST.ECR>101</PAGE.FIRST.ECR>
        <PAGE.FIRST.ECR>205</PAGE.FIRST.ECR>
      </BIB.JUDGMENT>
    </FORMEX>
  `);

  expect(bibliography.caseNumber).toEqual(["C-12/24", "C-13/24"]);
  expect(bibliography.author).toEqual(["CJ", "GCEU"]);
  expect(bibliography.sequence).toEqual(["4", "5"]);
  expect(bibliography.pages["PAGE.FIRST.ECR"]).toEqual(["101", "205"]);
});

test("keeps bibliography values ordered across Formex XML documents", () => {
  const bibliography = parseFormexBibliography([
    "<FORMEX><BIB.JUDGMENT><REF.CASE>C-12/24</REF.CASE></BIB.JUDGMENT></FORMEX>",
    "<FORMEX><BIB.JUDGMENT><REF.CASE>C-13/24</REF.CASE></BIB.JUDGMENT></FORMEX>",
  ]);

  expect(bibliography.caseNumber).toEqual(["C-12/24", "C-13/24"]);
});
