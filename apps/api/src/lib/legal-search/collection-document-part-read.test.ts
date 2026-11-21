import { expect, test } from "bun:test";
import * as v from "valibot";

import { collectionDocumentPartSchema } from "./collection-document-part";
import { collectionDocumentPartReadSchema } from "./collection-document-part-read";

test("every collection extent retains its composition fields without reading its headnote", () => {
  const common = {
    legalSentence: "Retained original headnote",
    keywords: ["Actual keyword"],
  };
  const descriptors = [
    {
      extent: "section",
      sectionNumber: 1,
      firstBlock: 2,
      afterLastBlock: 3,
      collectionLabel: "Printed label",
      ...common,
    },
    { extent: "complete", ...common },
    { extent: "unclassified", ...common },
  ];
  for (const descriptor of descriptors) {
    const stored = v.parse(collectionDocumentPartSchema, descriptor);
    const read = v.parse(collectionDocumentPartReadSchema, descriptor);
    expect(read).not.toHaveProperty("legalSentence");
    expect(read.keywords).toEqual(stored.keywords);
    expect(read.extent).toBe(stored.extent);
    expect(descriptor.legalSentence).toBe("Retained original headnote");
  }
});
