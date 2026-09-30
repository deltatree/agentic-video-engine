/**
 * Story 21.7: strukturierte Fehler in der Asset-Pipeline (abgebrochene Downloads).
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenVideoError } from '@agentic-video/core';
import { fetchAsset } from '@agentic-video/assets';

describe('fetchAsset (Story 21.7)', () => {
  it('meldet einen abgebrochenen Download als OpenVideoError mit Code', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '1000' });
      res.write(Buffer.alloc(10));
      setTimeout(() => res.socket?.destroy(), 20);
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? (address satisfies AddressInfo).port : 0;
    try {
      const error: unknown = await fetchAsset(`http://127.0.0.1:${String(port)}/x.png`, { allowPrivate: true }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(OpenVideoError);
      if (!(error instanceof OpenVideoError)) return;
      expect(error.diagnostic.code).toBe('OV_FETCH_INCOMPLETE');
      expect(error.diagnostic.details).toEqual({ receivedBytes: 10 });
      expect(error.diagnostic.suggestions.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});
