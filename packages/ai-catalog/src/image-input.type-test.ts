import { expectTypeOf } from "bun:test";

import { MODEL_IMAGE_INPUT_CAPABILITIES } from "./index";
import type {
  BYOKModelIdByProvider,
  BYOKProvider,
  ImageInputCapability,
} from "./index";

type ImageInputByProvider = {
  [TProvider in BYOKProvider]: Record<
    BYOKModelIdByProvider[TProvider],
    ImageInputCapability
  >;
};

expectTypeOf<
  typeof MODEL_IMAGE_INPUT_CAPABILITIES
>().toExtend<ImageInputByProvider>();

// An offered ID cannot be added without its explicit image-input decision.
// @ts-expect-error The added offered ID has no generated capability.
export const incomplete: ImageInputByProvider & {
  openai: Record<"additional-model", ImageInputCapability>;
} = MODEL_IMAGE_INPUT_CAPABILITIES;
