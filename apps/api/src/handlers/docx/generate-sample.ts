/* eslint-disable no-console */
/**
 * Quick script to generate a sample DOCX from Markdown.
 * Run: bun apps/api/src/handlers/docx/generate-sample.ts
 */

import { markdownToDocx } from "./markdown-to-docx";

const SAMPLE = `# Non-Disclosure Agreement

## Definitions

In this Agreement, the following terms shall have the meanings set out below:

### Confidential Information

#### Scope

Confidential Information means any information disclosed by one party to the other, whether orally, in writing, or by inspection of tangible objects, including:

- trade secrets and proprietary information;
- financial data and business plans;
- customer lists and supplier agreements;
- technical data and know-how.

> For the avoidance of doubt, Confidential Information shall not include information that is or becomes publicly available through no fault of the receiving party.

### Obligations of the Receiving Party

The Receiving Party agrees to:

- hold the Confidential Information in strict confidence;
- not disclose it to any third party without prior written consent;
- use it solely for the purposes of evaluating the proposed transaction.

## Term and Termination

This Agreement shall remain in effect for a period of **two (2) years** from the date of execution.

Either party may terminate this Agreement by providing **thirty (30) days** written notice to the other party.

## Governing Law

This Agreement shall be governed by and construed in accordance with the laws of the *Czech Republic*.

| Party | Role | Jurisdiction |
| --- | --- | --- |
| Alpha Corp | Disclosing Party | Czech Republic |
| Beta Ltd | Receiving Party | United Kingdom |

## Miscellaneous

### Entire Agreement

This Agreement constitutes the entire agreement between the parties with respect to the subject matter hereof and supersedes all prior negotiations, representations, warranties, commitments, offers, and contracts of every kind.

### Amendment

No amendment or modification of this Agreement shall be valid unless made in writing and signed by both parties.
`;

const TEMPLATE_PATH = new URL("fixtures/test-template.docx", import.meta.url)
  .pathname;

const run = async () => {
  const buffer = await markdownToDocx(SAMPLE, {
    templatePath: TEMPLATE_PATH,
  });
  const outputPath = "/Users/sok0/Downloads/stella-sample-nda.docx";
  await Bun.write(outputPath, buffer);
};

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
