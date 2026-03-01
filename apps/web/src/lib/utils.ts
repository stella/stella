export const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const shuffleArray = <T>(originalArray: T[]): T[] => {
  const array = [...originalArray];

  for (let i = array.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));

    const temp = array[randomIndex];
    array[randomIndex] = array[i];
    array[i] = temp;
  }

  return array;
};

export const truncate = (text: string, maxLength: number) => {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
};
