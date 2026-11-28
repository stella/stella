// parser-output-unchanged: test fixture lifecycle signal only; parsed output is unchanged.

let generation = 0;

export const publisherGateFixtureGeneration = () => generation;

/** The test runner advances this signal; reading it imports no runtime graph. */
export const advancePublisherGateFixtureGeneration = () => {
  generation += 1;
};
