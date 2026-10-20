export const setProcessEnvironment = (
  values: Record<string, string | undefined>,
) => {
  const originals = Object.entries(values).map(([key]) => ({
    key,
    present: Object.hasOwn(process.env, key),
    value: process.env[key],
  }));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      Reflect.set(process.env, key, value);
    }
  }
  return () => {
    for (const { key, present, value } of originals) {
      if (present) {
        Reflect.set(process.env, key, value);
      } else {
        Reflect.deleteProperty(process.env, key);
      }
    }
  };
};
