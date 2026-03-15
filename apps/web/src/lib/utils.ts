export const shuffleArray = <T>(originalArray: T[]): T[] => {
  const array = [...originalArray];

  for (let i = array.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));

    // SAFETY: i is in [1, array.length-1] and randomIndex
    // is in [0, i]; both always in bounds.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const a = array[i] as T;
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const b = array[randomIndex] as T;
    array[randomIndex] = a;
    array[i] = b;
  }

  return array;
};
