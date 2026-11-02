/**
 * Awaits independent operations together. Once every operation settles, the
 * failure earliest in argument order is thrown, as sequential awaits would
 * report it, so concurrency never changes which diagnostic a caller sees.
 */
export async function allInOrder<const T extends readonly unknown[]>(
  operations: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  for (const result of await Promise.allSettled(operations)) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
  return Promise.all(operations);
}
