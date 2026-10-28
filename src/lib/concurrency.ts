/**
 * Maps over items with at most `limit` promises in flight. Results preserve input order.
 * The first rejection stops scheduling new work and is re-thrown once in-flight work settles.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new RangeError('limit must be >= 1');
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;

  const runner = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  if (failure) throw failure.error;
  return results;
}
