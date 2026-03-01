/**
 * Copyright 2024 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

// modified utils with clearer variable names taken from pdfjs-dist viewer code

export const approximateFraction = (x: number): [number, number] => {
  if (Math.floor(x) === x) {
    return [x, 1];
  }

  const invertedX = 1 / x;
  const limit = 8;

  if (invertedX > limit) {
    return [1, limit];
  }

  if (Math.floor(invertedX) === invertedX) {
    return [1, invertedX];
  }

  const fractionX = x > 1 ? invertedX : x;
  let lowerNumerator = 0;
  let lowerDenominator = 1;
  let upperNumerator = 1;
  let upperDenominator = 1;

  while (true) {
    const sumNumerator = lowerNumerator + upperNumerator;
    const sumDenominator = lowerDenominator + upperDenominator;

    if (sumDenominator > limit) {
      break;
    }

    if (fractionX <= sumNumerator / sumDenominator) {
      upperNumerator = sumNumerator;
      upperDenominator = sumDenominator;
    } else {
      lowerNumerator = sumNumerator;
      lowerDenominator = sumDenominator;
    }
  }

  let result: [number, number];

  if (
    fractionX - lowerNumerator / lowerDenominator <
    upperNumerator / upperDenominator - fractionX
  ) {
    result =
      fractionX === x
        ? [lowerNumerator, lowerDenominator]
        : [lowerDenominator, lowerNumerator];
  } else {
    result =
      fractionX === x
        ? [upperNumerator, upperDenominator]
        : [upperDenominator, upperNumerator];
  }

  return result;
};

export const floorToMultiple = (x: number, divider: number) => {
  return x - (x % divider);
};
