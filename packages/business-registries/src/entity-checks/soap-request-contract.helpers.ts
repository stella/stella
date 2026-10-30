import { panic } from "better-result";
import { SaxesParser } from "saxes";

export type SchemaChild = {
  name: string;
  minOccurs: number;
  maxOccurs: number | "unbounded";
};

export type RequestSchema = {
  namespace: string;
  root: string;
  children: SchemaChild[];
};

type Sequence = { owner: string; children: SchemaChild[] };

const occurrence = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  return Number(value);
};

const maximumOccurrence = (value: string | undefined): number | "unbounded" =>
  value === "unbounded" ? "unbounded" : occurrence(value, 1);

const localName = (qualifiedName: string): string =>
  qualifiedName.split(":").at(-1) ?? qualifiedName;

/** Read one request element and its ordered children from an XSD or WSDL. */
export const readRequestSchema = (
  xml: string,
  requestElement: string,
): RequestSchema => {
  const schema: { namespace: string; referencedType: string | null } = {
    namespace: "",
    referencedType: null,
  };
  let schemaDepth = 0;
  let elementDepth = 0;
  let sequence: Sequence | null = null;
  const sequences = new Map<string, SchemaChild[]>();
  const parser = new SaxesParser();

  parser.on("opentag", ({ name, attributes }) => {
    const element = localName(name);
    if (element === "schema") {
      schemaDepth += 1;
      if (schemaDepth === 1) {
        schema.namespace = attributes["targetNamespace"] ?? "";
      }
      return;
    }
    if (schemaDepth === 0) {
      return;
    }
    if (element === "complexType") {
      const owner = attributes["name"];
      if (owner !== undefined) {
        sequence = { owner, children: [] };
      }
      return;
    }
    if (element === "sequence" && elementDepth > 0) {
      sequence = { owner: requestElement, children: [] };
      return;
    }
    if (element !== "element") {
      return;
    }
    const nameAttribute = attributes["name"];
    if (elementDepth === 0 && nameAttribute === requestElement) {
      elementDepth = 1;
      const type = attributes["type"];
      schema.referencedType = type === undefined ? null : localName(type);
      return;
    }
    if (elementDepth > 0) {
      elementDepth += 1;
    }
    if (sequence !== null && nameAttribute !== undefined) {
      sequence.children.push({
        name: nameAttribute,
        minOccurs: occurrence(attributes["minOccurs"], 1),
        maxOccurs: maximumOccurrence(attributes["maxOccurs"]),
      });
    }
  });
  parser.on("closetag", ({ name }) => {
    const element = localName(name);
    if (element === "schema") {
      schemaDepth -= 1;
    }
    if (element === "complexType" && sequence !== null) {
      sequences.set(sequence.owner, sequence.children);
      sequence = null;
    }
    if (element === "element" && elementDepth > 0) {
      elementDepth -= 1;
    }
  });
  parser.write(xml).close();

  const children =
    sequences.get(requestElement) ??
    (schema.referencedType === null
      ? undefined
      : sequences.get(schema.referencedType));
  if (schema.namespace === "" || children === undefined) {
    return panic(`Request element ${requestElement} was not found in schema`);
  }
  return { namespace: schema.namespace, root: requestElement, children };
};

export type RequestElement = {
  name: string;
  namespace: string;
  text: string;
};

export type SoapBody = {
  root: RequestElement;
  children: RequestElement[];
};

/** Read the request element and its direct children from a SOAP envelope. */
export const readSoapBody = (xml: string): SoapBody => {
  let bodyDepth = 0;
  const document: { root: RequestElement | null } = { root: null };
  const children: RequestElement[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    if (
      tag.local === "Body" &&
      tag.uri === "http://schemas.xmlsoap.org/soap/envelope/"
    ) {
      bodyDepth = 1;
      return;
    }
    if (bodyDepth === 0) {
      return;
    }
    bodyDepth += 1;
    const element = { name: tag.local, namespace: tag.uri, text: "" };
    if (bodyDepth === 2) {
      document.root = element;
    } else if (bodyDepth === 3) {
      children.push(element);
    }
  });
  parser.on("text", (text) => {
    if (bodyDepth === 3) {
      const child = children.at(-1);
      if (child !== undefined) {
        child.text += text;
      }
    }
  });
  parser.on("closetag", () => {
    if (bodyDepth > 0) {
      bodyDepth -= 1;
    }
  });
  parser.write(xml).close();
  if (document.root === null) {
    return panic("SOAP Body has no request element");
  }
  return { root: document.root, children };
};

/** Return all contract violations for a parsed SOAP request. */
export const requestContractViolations = (
  body: SoapBody,
  schema: RequestSchema,
): string[] => {
  const violations: string[] = [];
  if (
    body.root.name !== schema.root ||
    body.root.namespace !== schema.namespace
  ) {
    violations.push(
      `expected root {${schema.namespace}}${schema.root}, received {${body.root.namespace}}${body.root.name}`,
    );
  }
  const positions = new Map(
    schema.children.map(({ name }, index) => [name, index]),
  );
  const counts = new Map<string, number>();
  let previousPosition = -1;
  for (const child of body.children) {
    const position = positions.get(child.name);
    if (position === undefined) {
      violations.push(`undeclared child ${child.name}`);
      continue;
    }
    if (position < previousPosition) {
      violations.push(`child ${child.name} is out of sequence`);
    }
    previousPosition = position;
    counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
    if (child.text.trim() === "") {
      violations.push(`child ${child.name} is empty`);
    }
  }
  for (const child of schema.children) {
    const count = counts.get(child.name) ?? 0;
    if (count < child.minOccurs) {
      violations.push(`required child ${child.name} is missing`);
    }
    if (child.maxOccurs !== "unbounded" && count > child.maxOccurs) {
      violations.push(
        `child ${child.name} exceeds maxOccurs ${child.maxOccurs}`,
      );
    }
  }
  return violations;
};
