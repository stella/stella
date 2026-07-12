export class BoundedSet<T> {
  private readonly limit: number;
  private readonly values = new Set<T>();

  constructor(limit: number) {
    if (limit < 1) {
      throw new RangeError("BoundedSet limit must be positive");
    }
    this.limit = limit;
  }

  add(value: T) {
    this.values.delete(value);
    this.values.add(value);
    if (this.values.size <= this.limit) {
      return;
    }
    const oldest = this.values.values().next();
    if (!oldest.done) {
      this.values.delete(oldest.value);
    }
  }

  has(value: T) {
    return this.values.has(value);
  }

  delete(value: T) {
    return this.values.delete(value);
  }
}

export class BoundedMap<K, V> {
  private readonly limit: number;
  private readonly values = new Map<K, V>();

  constructor(limit: number) {
    if (limit < 1) {
      throw new RangeError("BoundedMap limit must be positive");
    }
    this.limit = limit;
  }

  get(key: K) {
    return this.values.get(key);
  }

  set(key: K, value: V) {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size <= this.limit) {
      return;
    }
    const oldest = this.values.keys().next();
    if (!oldest.done) {
      this.values.delete(oldest.value);
    }
  }
}
