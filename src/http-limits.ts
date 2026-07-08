/** Default ceiling for response bodies we buffer fully into memory. */
export const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Read a fetch Response body as text, aborting if it exceeds maxBytes. Prevents
 * a huge/hostile document (e.g. an enormous sitemap) from being pulled fully
 * into memory and then parsed synchronously — which would spike memory and
 * stall the event loop for every other in-flight request.
 */
export async function readTextCapped(
  res: Response,
  maxBytes = MAX_BODY_BYTES,
): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw new Error(`Response too large: ${declared} bytes (max ${maxBytes})`);
  }

  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
