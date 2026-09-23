/**
 * A module-scope keyed store whose owner removes each entry when the thing it
 * tracks ends (a turn settles, a surface unmounts, a session goes idle).
 * Holding one in a bare `Map` hides that eviction duty; the type names it.
 */
export class LifecycleRegistry<K, V> {
  private readonly entries = new Map<K, V>();

  get size() {
    return this.entries.size;
  }

  get(key: K) {
    return this.entries.get(key);
  }

  set(key: K, value: V) {
    this.entries.set(key, value);
  }

  delete(key: K) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  values() {
    return this.entries.values();
  }

  [Symbol.iterator]() {
    return this.entries[Symbol.iterator]();
  }
}
