import * as v from "valibot";

export const taskDescriptionSchema = v.nullable(
  v.pipe(v.string(), v.maxLength(10_000)),
);

export const organizationMemberSelectorSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(320),
);
