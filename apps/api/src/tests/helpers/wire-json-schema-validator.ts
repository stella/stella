import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { AGENT_INPUT_NORMALIZATION_KEY } from "@stll/agent-input";

/**
 * An independent reading of the JSON Schemas the MCP surface publishes: Ajv's
 * draft-07 validator, the dialect the generator targets, in strict mode so an
 * unknown keyword or a keyword on the wrong type fails compilation instead of
 * being ignored. The one extension keyword the surface emits is registered as
 * an annotation.
 */
export const createWireSchemaValidator = (): Ajv => {
  const ajv = new Ajv({ allowUnionTypes: true, strict: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: AGENT_INPUT_NORMALIZATION_KEY });
  return ajv;
};

/**
 * Compiles a schema exactly as the surface publishes it. The SDK types an
 * absent `$schema` as `string | undefined`, which Ajv's schema type does not
 * admit under exact optional properties; the published object is read as a
 * plain JSON object instead.
 */
export const compileWireSchema = (
  ajv: Ajv,
  schema: Readonly<Record<string, unknown>>,
): ValidateFunction => ajv.compile(schema);
