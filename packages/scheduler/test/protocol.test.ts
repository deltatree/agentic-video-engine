import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MessageDecoder, collectProjectFiles, encodeMessage, isSafeRelativePath, type ProtocolMessage } from '@agentic-video/scheduler';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const request = { compositionId: 'main', start: 0, end: 10, scale: 1, step: 1, offset: 0 };

describe('Worker-Protokoll', () => {
  it('überträgt alle Nachrichtenarten, auch in beliebig zerteilten Stücken', () => {
    const messages: ProtocolMessage[] = [
      { type: 'init', mode: 'stream', worker: 'w1', project: { a: 1 }, options: { offline: true }, files: [{ path: 'assets/a.bin', bytes: new Uint8Array([1, 2, 3]) }, { path: 'b.txt', bytes: new Uint8Array([9]) }] },
      { type: 'init', mode: 'shared', worker: 'w2', project: { b: 2 }, options: {}, projectDir: '/p', cacheDir: '/c' },
      { type: 'chunk', id: 'c1', request, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
      { type: 'frame', key: 'sha256:abc', bytes: new Uint8Array([5, 6, 7, 8]) },
      { type: 'result', id: 'c1', result: { start: 0, end: 1, frameHashes: ['h'], keys: ['k'], rendered: 1, fromCache: 0, diagnostics: [] } },
      { type: 'error', id: 'c1', diagnostic: { code: 'OV_X', severity: 'error', errorClass: 'E', problem: 'p', suggestions: [] } },
      { type: 'log', line: '{"message":"hi"}' },
      { type: 'shutdown' },
    ];
    const bytes = Buffer.concat(messages.map((m) => Buffer.from(encodeMessage(m))));
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: bytes.length }), { maxLength: 12 }), (cuts) => {
        const points = [...new Set(cuts)].sort((a, b) => a - b);
        const decoder = new MessageDecoder();
        const out: ProtocolMessage[] = [];
        let last = 0;
        for (const p of [...points, bytes.length]) {
          out.push(...decoder.push(bytes.subarray(last, p)));
          last = p;
        }
        expect(out).toEqual(messages);
      }),
    );
  });

  it('weist ungültige Rahmen mit Diagnose ab', () => {
    const json = Buffer.from(JSON.stringify({ type: 'chunk', id: 'x' }));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(json.length);
    expect(() => new MessageDecoder().push(Buffer.concat([prefix, json]))).toThrow(/chunk needs/);
  });

  it('sammelt Projektdateien ohne versteckte Ordner und prüft Pfade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-files-'));
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, '.openvideo'));
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'assets', 'a.txt'), 'a');
    writeFileSync(join(dir, '.openvideo', 'x'), 'x');
    writeFileSync(join(dir, 'out', 'v.mp4'), 'v');
    writeFileSync(join(dir, 'project.json'), '{}');
    const files = await collectProjectFiles(dir);
    expect(files.map((f) => f.path)).toEqual(['assets/a.txt', 'project.json']);
    expect(isSafeRelativePath('assets/a.txt')).toBe(true);
    expect(isSafeRelativePath('../etc/passwd')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('a//b')).toBe(false);
  });
});
