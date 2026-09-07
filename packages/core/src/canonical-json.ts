function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  const object = value as Record<string, unknown>;
  return Object.keys(object)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const item = object[key];
      if (item !== undefined) {
        result[key] = normalize(item);
      }
      return result;
    }, {});
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}
