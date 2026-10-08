/**
 * Constant-time string comparison.
 *
 * Both inputs are UTF-8 encoded and XOR-ed byte by byte over the longer
 * length, so the time taken does not depend on where the first difference
 * is, nor (beyond the length itself) on how long the shorter input is.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
