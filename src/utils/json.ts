/**
 * Safely parses JSON strings asynchronously without blocking the event loop.
 * For small strings (< 50KB), it parses synchronously for speed.
 * For large strings, it yields to the Node.js event loop using setImmediate
 * before parsing to prevent blocking other concurrent microtasks.
 */
export async function asyncJsonParse<T>(text: string): Promise<T> {
  if (text.length < 50000) { // < 50KB
    return JSON.parse(text) as T;
  }
  return new Promise<T>((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
  });
}
