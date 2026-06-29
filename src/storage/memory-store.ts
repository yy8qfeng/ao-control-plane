export class MemoryStore<T> {
  private readonly records = new Map<string, T>();

  set(id: string, value: T): void {
    this.records.set(id, value);
  }

  get(id: string): T | undefined {
    return this.records.get(id);
  }

  list(): T[] {
    return Array.from(this.records.values());
  }
}
