/**
 * Review Q2: Argumente eines Plugin-Codecs werden per Allowlist geprüft, nicht per Blacklist.
 * Enthält alle Umgehungen aus dem Review (positionale Ausgabe, movie@, drawtext=textfile,
 * -progress, -filter_complex_script) und weitere.
 */
import { describe, expect, it } from 'vitest';
import { OpenVideoError } from '@agentic-video/core';
import { checkCustomCodecArgs } from '@agentic-video/ffmpeg';

function codeOf(args: readonly string[]): string | undefined {
  try {
    checkCustomCodecArgs({ id: 'probe', formats: ['mp4'], args });
    return undefined;
  } catch (error: unknown) {
    if (error instanceof OpenVideoError) return error.diagnostic.code;
    throw error;
  }
}

describe('checkCustomCodecArgs: erlaubte Argumente', () => {
  it.each([
    [['-c:v', 'libx264', '-crf', '20']],
    [['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30']],
    [['-codec:v', 'libx265', '-x265-params', 'keyint=60:min-keyint=30:no-open-gop', '-tag:v', 'hvc1']],
    [['-vcodec', 'libx264', '-x264-params', 'keyint=48:bframes=2:deblock=-1,-1', '-profile:v', 'high', '-level', '4.1']],
    [['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '31', '-row-mt', '1', '-cpu-used', '-4', '-deadline', 'good', '-tile-columns', '2']],
    [['-c:v', 'libx264', '-b:v', '2500k', '-maxrate', '3M', '-bufsize', '6M', '-g', '60', '-keyint_min', '30', '-bf', '3']],
    [['-c:v', 'libx264', '-movflags', '+faststart+frag_keyframe']],
    [['-c:v', 'libaom-av1', '-tiles', '2x2', '-speed', '6', '-preset:v', 'slow']],
  ])('%j', (args) => {
    expect(codeOf(args)).toBeUndefined();
  });
});

describe('checkCustomCodecArgs: Umgehungen aus dem Review und weitere', () => {
  it.each([
    // Positionale zweite Ausgabe (Datei außerhalb des Projekts schreiben).
    ['positionale Ausgabe', ['-c:v', 'libx264', '/tmp/pwned.mp4']],
    ['positionale Ausgabe nach Wert', ['-c:v', 'libx264', '-crf', '20', 'out.mkv']],
    // Filter mit Datei-/Netzquellen.
    ['movie@', ['-c:v', 'libx264', '-vf', 'movie@x=/etc/passwd']],
    ['drawtext textfile', ['-c:v', 'libx264', '-vf', 'drawtext=textfile=/etc/passwd']],
    ['-filter:v', ['-c:v', 'libx264', '-filter:v', 'scale=2:2']],
    ['-filter_complex_script', ['-c:v', 'libx264', '-filter_complex_script', '/tmp/graph.txt']],
    ['-filter_script:v', ['-c:v', 'libx264', '-filter_script:v', '/tmp/f.txt']],
    ['-lavfi', ['-c:v', 'libx264', '-lavfi', 'nullsrc']],
    // Fortschritt/Berichte schreiben Dateien oder öffnen URLs.
    ['-progress', ['-c:v', 'libx264', '-progress', '/tmp/progress.txt']],
    ['-report', ['-report', '-c:v', 'libx264']],
    ['-vstats_file', ['-c:v', 'libx264', '-vstats_file', '/tmp/x']],
    ['-passlogfile', ['-c:v', 'libx264', '-passlogfile', '/tmp/x']],
    ['-stats_enc_pre', ['-c:v', 'libx264', '-stats_enc_pre', '/tmp/x']],
    // Eingaben, Muxer, Mappings.
    ['-i', ['-c:v', 'libx264', '-i', 'x.mp4']],
    ['-f', ['-c:v', 'libx264', '-f', 'rtp']],
    ['-map', ['-c:v', 'libx264', '-map', '0:a']],
    ['-attach', ['-c:v', 'libx264', '-attach', '/etc/passwd']],
    ['-y', ['-y', '-c:v', 'libx264']],
    // Von OpenVideo gesteuert.
    ['-threads', ['-c:v', 'libx264', '-threads', '64']],
    ['-r', ['-c:v', 'libx264', '-r', '1']],
    ['-s', ['-c:v', 'libx264', '-s', '8x8']],
    // Werte mit Pfaden oder Datei-Schlüsseln.
    ['x264 stats-Datei', ['-c:v', 'libx264', '-x264-params', 'stats=/tmp/x.log']],
    ['x264 dump-yuv relativ', ['-c:v', 'libx264', '-x264-params', 'keyint=60:dump-yuv=out']],
    ['x265 csv', ['-c:v', 'libx265', '-x265-params', 'csv=log.csv']],
    ['x265 analysis-save', ['-c:v', 'libx265', '-x265-params', 'analysis-save=a.dat']],
    ['Parameterwert mit Pfad', ['-c:v', 'libx264', '-x264-params', 'keyint=../x']],
    ['Encoder-Name mit Leerzeichen', ['-c:v', 'libx264 -i x', '-crf', '20']],
    ['Encoder-Name als URL', ['-c:v', 'http://evil/x']],
    ['-movflags unbekannt', ['-c:v', 'libx264', '-movflags', '+faststart+use_editlist']],
    ['-movflags mit Pfad', ['-c:v', 'libx264', '-movflags', '/tmp/x']],
    ['preset mit Pfad', ['-c:v', 'libx264', '-preset', '../../x']],
    ['crf keine Zahl', ['-c:v', 'libx264', '-crf', '20;rm']],
    ['fehlender Wert', ['-c:v', 'libx264', '-crf']],
    ['-c ohne Stream (setzt auch Audio)', ['-c', 'libx264']],
    ['kein Encoder', ['-crf', '20']],
    ['leeres Argument', ['-c:v', 'libx264', '']],
  ])('%s', (_name, args) => {
    expect(codeOf(args)).toBe('OV_ENCODE_CODEC_ARGS');
  });
});
