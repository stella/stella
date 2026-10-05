import type { Attr, Document, Element } from "slimdom";

const PROPERTY_FIELDS = new Set([
  "creator",
  "lastmodifiedby",
  "company",
  "manager",
  "template",
  "title",
  "subject",
  "keywords",
  "keyword",
  "description",
  "initial-creator",
  "printed-by",
  "user-defined",
  "category",
  "contentstatus",
]);
const PROPERTY_ATTRIBUTES = new Set(["href", "name", "title"]);
const OFFICE_IDENTITY_ATTRIBUTE_POLICIES = {
  author: { type: "replace", replacement: "Author" },
  initials: { type: "replace", replacement: "A" },
  userid: { type: "remove" },
  providerid: { type: "remove" },
  displayname: { type: "replace", replacement: "Author" },
  email: { type: "remove" },
  emailaddress: { type: "remove" },
  name: { type: "replace", replacement: "Author" },
} as const;
const IDENTITY_ATTRIBUTES = new Set(
  Object.keys(OFFICE_IDENTITY_ATTRIBUTE_POLICIES).filter(
    (name) => name !== "name",
  ),
);
export const officeIdentityAttributePolicy = (name: string) =>
  Object.entries(OFFICE_IDENTITY_ATTRIBUTE_POLICIES).find(
    ([key]) => key === name.toLowerCase(),
  )?.[1];

export const isOfficeCollaborationPart = (part: string): boolean =>
  /^(?:content\.xml|(?:word|xl|ppt)\/.*\.xml)$/iu.test(part);
const NAMED_IDENTITIES = new Set([
  "person",
  "author",
  "cmauthor",
  "commentauthor",
  "mention",
]);
const DC_NAMESPACE = "http://purl.org/dc/elements/1.1/";

/** All XML parts in which office producers store properties or collaboration identities. */
export const isOfficeIdentityPart = (part: string): boolean =>
  /^(?:docProps\/(?:core|app|custom)\.xml|meta\.xml)$/iu.test(part) ||
  isOfficeCollaborationPart(part);

export type OfficeIdentityField =
  | { type: "text"; node: Element; field: string }
  | { type: "attribute"; node: Attr; field: string };

/** Internal reference IDs and document/comment body text are deliberately excluded. */
export const officeIdentityFields = (
  document: Document,
  part: string,
): OfficeIdentityField[] => {
  const result: OfficeIdentityField[] = [];
  const propertyPart = /^(?:docProps\/(?:core|app)\.xml|meta\.xml)$/iu.test(
    part,
  );
  const customPart = /^docProps\/custom\.xml$/iu.test(part);
  for (const element of document.getElementsByTagNameNS("*", "*")) {
    const name = element.localName.toLowerCase();
    const propertyField = propertyPart && PROPERTY_FIELDS.has(name);
    const customField = customPart && name === "property";
    const authorText =
      /^xl\/comments[^/]*\.xml$/iu.test(part) && name === "author";
    const odfCreator =
      part === "content.xml" &&
      element.namespaceURI === DC_NAMESPACE &&
      name === "creator";
    if (propertyField || customField || authorText || odfCreator) {
      result.push({ type: "text", node: element, field: element.localName });
    }
    for (const attribute of element.attributes) {
      const attr = attribute.localName.toLowerCase();
      if (
        !(
          (propertyField && PROPERTY_ATTRIBUTES.has(attr)) ||
          (customField && attr === "name") ||
          (!propertyPart &&
            !customPart &&
            (IDENTITY_ATTRIBUTES.has(attr) ||
              (attr === "name" && NAMED_IDENTITIES.has(name))))
        )
      ) {
        continue;
      }
      result.push({
        type: "attribute",
        node: attribute,
        field: `${element.localName}@${attribute.localName}`,
      });
    }
  }
  return result;
};
