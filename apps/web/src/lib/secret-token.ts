import { panic } from "better-result";

const secretTokenBrand: unique symbol = Symbol("secretToken");

export type SecretToken<TName extends string> = {
  readonly [secretTokenBrand]: TName;
  readonly [Symbol.toStringTag]: "SecretToken";
  readonly toString: () => never;
  readonly [Symbol.toPrimitive]: () => never;
};

export const createSecretTokenBoundary = <const TName extends string>(
  name: TName,
) => {
  const rawTokenValues = new WeakMap<SecretToken<TName>, string>();

  return {
    create(value: string): SecretToken<TName> {
      if (value.length === 0) {
        panic(`Cannot create empty secret token: ${name}`);
      }

      const token: SecretToken<TName> = {
        [secretTokenBrand]: name,
        [Symbol.toStringTag]: "SecretToken",
        toString() {
          throw new TypeError(
            `Secret token cannot be converted to string: ${name}`,
          );
        },
        [Symbol.toPrimitive]() {
          throw new TypeError(
            `Secret token cannot be converted to string: ${name}`,
          );
        },
      };

      rawTokenValues.set(token, value);
      return Object.freeze(token);
    },
    reveal(token: SecretToken<TName>): string {
      const value = rawTokenValues.get(token);

      if (!value) {
        panic(`Secret token was not created by this boundary: ${name}`);
      }

      return value;
    },
  };
};
