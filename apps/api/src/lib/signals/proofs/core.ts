// Based on gdp-ts (MIT, Guillermo Rauch); see GDP-LICENSE.
// Names are invariant and scoped to a generic callback; they never encode raw IDs.
declare const NAME: unique symbol;
declare const ABOUT: unique symbol;

export type Named<in out N, out A> = {
  readonly value: A;
  readonly [NAME]: (name: N) => N;
};

export type Proof<
  in out Kind extends string,
  in out About extends readonly unknown[],
> = {
  readonly kind: Kind;
  readonly [ABOUT]: (about: About) => About;
};

class NamedValue<N, A> implements Named<N, A> {
  declare readonly [NAME]: (name: N) => N;
  readonly value: A;
  constructor(value: A) {
    this.value = value;
    Object.freeze(this);
  }
}

class ProofValue<
  Kind extends string,
  About extends readonly unknown[],
> implements Proof<Kind, About> {
  declare readonly [ABOUT]: (about: About) => About;
  readonly kind: Kind;
  constructor(kind: Kind) {
    this.kind = kind;
    Object.freeze(this);
  }
}

export const name = <A, B, C, R>(
  a: A,
  b: B,
  c: C,
  run: <U, S, T>(a: Named<U, A>, b: Named<S, B>, c: Named<T, C>) => R,
): R => run(new NamedValue(a), new NamedValue(b), new NamedValue(c));

export const defineProof = <const Kind extends string>(kind: Kind) => ({
  prove: <U, S, T, A, B, C>(
    _actor: Named<U, A>,
    _resource: Named<S, B>,
    _transaction: Named<T, C>,
  ): Proof<Kind, [U, S, T]> => new ProofValue(kind),
});
