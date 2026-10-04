// Web Crypto is global in browsers and Node, but this package compiles without
// DOM or Node types, so declare the one function it uses.
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

/**
 * A UUIDv7 (RFC 9562): the first 48 bits are the Unix time in milliseconds and
 * the rest is random. IDs created later sort later, even as plain strings, so a
 * DynamoDB sort key made of them comes back in creation order for free.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  // Big-endian timestamp in bytes 0–5. JavaScript's bit shifts only work on
  // 32 bits, so peel off one byte at a time with arithmetic instead.
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
