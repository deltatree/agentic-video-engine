import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import Value from 'typebox/value';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RectNode,
  SCHEMA_VERSION,
  buildJsonSchema,
  formatDiagnostic,
  friendlyPath,
  migrateProject,
  validateProject,
  validateValue,
  type IrProject,
} from '@agentic-video/schema';

function project(nodes: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    compositions: [{ id: 'hero', width: 1920, height: 1080, fps: 30, duration: '5s', nodes }],
    ...extra,
  };
}

describe('validateProject', () => {
  it('akzeptiert ein gültiges, typisiertes Project', () => {
    const p: IrProject = {
      schemaVersion: SCHEMA_VERSION,
      settings: { theme: { colors: { primary: '#FF5500' } } },
      compositions: [
        {
          id: 'hero',
          width: 1920,
          height: 1080,
          fps: 30,
          duration: '5s',
          markers: [{ id: 'intro', time: '1s' }],
          nodes: [
            { id: 'bg', type: 'rect', width: 1920, height: 1080, fill: { $ref: 'theme.colors.primary' } },
            {
              id: 'headline',
              type: 'text',
              text: 'The future is programmable.',
              fontSize: 92,
              x: 120,
              y: { $keyframes: [{ t: 0, v: 800 }, { t: 'marker:intro+10f', v: 760, ease: 'easeOutCubic' }] },
              opacity: { $spring: { from: 0, to: 1, at: 20 } },
              rotation: { $expr: 'sin(time * 2) * 4' },
            },
            {
              id: 'card',
              type: 'group',
              children: [{ id: 'dot', type: 'ellipse', width: 20, height: 20, fill: '#FFFFFF' }],
              mask: { node: { id: 'mask-rect', type: 'rect', width: 100, height: 100 } },
            },
            {
              id: 'scene',
              type: 'scene3d',
              width: 1920,
              height: 1080,
              camera: 'cam',
              children: [
                { id: 'cam', type: 'camera3d', position: [0, 1, 5] },
                { id: 'box', type: 'mesh3d', geometry: { type: 'box' }, rotation: { $keyframes: [{ t: 0, v: [0, 0, 0] }, { t: '5s', v: [0, 360, 0] }] } },
              ],
            },
          ],
        },
      ],
    };
    const result = validateProject(p);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('meldet den Fehler aus Auftrag A4 mit Pfad, Erwartung, Wert und Vorschlag', () => {
    const result = validateProject(project([{ id: 'logo', type: 'rect', width: 10, height: 10, scale: { x: 'large', y: 1 } }]));
    expect(result.ok).toBe(false);
    const d = result.diagnostics[0]!;
    expect(d.path).toBe('composition.hero.nodes.logo.scale.x');
    expect(d.expected).toBe('number');
    expect(d.received).toBe('"large"');
    expect(d.suggestions[0]).toBe('scale: { x: 1, y: 1 }');
    expect(d.nodeId).toBe('logo');
    expect(formatDiagnostic(d)).toContain('composition.hero.nodes.logo.scale.x\n\nExpected number\nReceived: "large"\n\nSuggested fix:\nscale: { x: 1, y: 1 }');
  });

  it('meldet Bereichsfehler mit Grenze', () => {
    const result = validateProject(project([{ id: 'r', type: 'rect', width: -5, height: 10 }]));
    expect(result.diagnostics[0]?.expected).toBe('number >= 0');
    expect(result.diagnostics[0]?.path).toBe('composition.hero.nodes.r.width');
  });

  it('schlägt bei unbekannten Properties den ähnlichsten Namen vor', () => {
    const result = validateProject(project([{ id: 't', type: 'text', text: 'Hi', fontSzie: 20 }]));
    const d = result.diagnostics.find((x) => x.code === 'OV_SCHEMA_UNKNOWN_PROPERTY');
    expect(d?.suggestions[0]).toBe('Did you mean "fontSize"?');
  });

  it('schlägt bei unbekanntem Node-Typ den ähnlichsten Typ vor', () => {
    const result = validateProject(project([{ id: 't', type: 'rectangle', width: 1, height: 1 }]));
    expect(result.diagnostics[0]?.suggestions[0]).toBe('type: "rect"');
  });

  it('meldet fehlende Pflichtfelder mit Beispiel', () => {
    const result = validateProject({ schemaVersion: SCHEMA_VERSION, compositions: [{ id: 'c', height: 1080, fps: 30, duration: 10, nodes: [] }] });
    const d = result.diagnostics.find((x) => x.code === 'OV_SCHEMA_REQUIRED');
    expect(d?.path).toBe('composition.c.width');
    expect(d?.suggestions[0]).toBe('width: 1920');
  });

  it('meldet doppelte Node-IDs mit beiden Pfaden', () => {
    const result = validateProject(project([
      { id: 'a', type: 'rect', width: 1, height: 1 },
      { id: 'g', type: 'group', children: [{ id: 'a', type: 'ellipse', width: 1, height: 1 }] },
    ]));
    const d = result.diagnostics.find((x) => x.code === 'OV_SCHEMA_DUPLICATE_ID');
    expect(d?.problem).toContain('/compositions/0/nodes/0');
    expect(d?.problem).toContain('/compositions/0/nodes/1/children/0');
  });

  it('prüft Keyframe-Easings im richtigen Zweig', () => {
    const result = validateProject(project([{ id: 'r', type: 'rect', width: 1, height: 1, x: { $keyframes: [{ t: 0, v: 0, ease: 'easeInOutWobble' }] } }]));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.path).toBe('composition.hero.nodes.r.x.$keyframes.0.ease');
  });

  it('erkennt unbekannte Animations-Schlüssel', () => {
    const result = validateProject(project([{ id: 'r', type: 'rect', width: 1, height: 1, x: { $keyframe: [] } }]));
    expect(result.diagnostics[0]?.suggestions[0]).toBe('Use "$keyframes".');
  });

  it('meldet fehlende Assets, falsche Asset-Typen und 3D-Platzierung', () => {
    const result = validateProject(
      project(
        [
          { id: 'img', type: 'image', asset: 'logo' },
          { id: 'vid', type: 'video', asset: 'pic' },
          { id: 'cam', type: 'camera3d' },
        ],
        { assets: [{ id: 'pic', type: 'image', src: './pic.png' }] },
      ),
    );
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('OV_ASSET_UNKNOWN');
    expect(codes).toContain('OV_ASSET_TYPE');
    expect(codes).toContain('OV_SCHEMA_PLACEMENT');
  });

  it('meldet Kamera-, Marker-, Theme- und Zyklusfehler', () => {
    const result = validateProject({
      schemaVersion: SCHEMA_VERSION,
      settings: { theme: { colors: { primary: '#000000' } } },
      compositions: [
        {
          id: 'a',
          width: 10,
          height: 10,
          fps: 30,
          duration: 10,
          nodes: [
            { id: 'ref', type: 'composition-ref', composition: 'b' },
            { id: 's', type: 'scene3d', width: 10, height: 10, camera: 'nope', children: [] },
            { id: 'r', type: 'rect', width: 1, height: 1, x: { $keyframes: [{ t: 'marker:missing', v: 1 }] }, fill: { $ref: 'theme.colors.primray' } },
          ],
        },
        { id: 'b', width: 10, height: 10, fps: 30, duration: 10, nodes: [{ id: 'back', type: 'composition-ref', composition: 'a' }] },
      ],
    });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['OV_SCHEMA_CAMERA', 'OV_TIME_MARKER', 'OV_THEME_REF', 'OV_SCHEMA_CYCLE']));
    expect(result.diagnostics.find((d) => d.code === 'OV_THEME_REF')?.suggestions[0]).toBe('{ "$ref": "theme.colors.primary" }');
  });

  it('warnt, wenn renderProfile.colorSpace und settings.outputColorSpace abweichen (Story 17.11)', () => {
    const mismatch = validateProject(project([], { settings: { outputColorSpace: 'rec709' }, renderProfiles: [{ id: 'web', format: 'mp4', colorSpace: 'srgb' }, { id: 'tv', format: 'mp4', colorSpace: 'rec709' }, { id: 'plain', format: 'mp4' }] }));
    expect(mismatch.ok).toBe(true);
    const warnings = mismatch.diagnostics.filter((d) => d.code === 'OV_COLORSPACE_MISMATCH');
    expect(warnings.map((d) => [d.severity, d.pointer])).toEqual([
      ['warning', '/renderProfiles/0/colorSpace'],
      ['warning', '/renderProfiles/2'],
    ]);
    expect(warnings[0]?.suggestions[0]).toBe('Set renderProfiles[0].colorSpace to "rec709".');
    const match = validateProject(project([], { renderProfiles: [{ id: 'web', format: 'mp4', colorSpace: 'srgb' }, { id: 'plain', format: 'mp4' }] }));
    expect(match.diagnostics.map((d) => d.code)).not.toContain('OV_COLORSPACE_MISMATCH');
  });

  it('meldet inkompatible Schema-Versionen', () => {
    const result = validateProject({ ...project([]), schemaVersion: '2.0.0' });
    expect(result.diagnostics[0]?.code).toBe('OV_SCHEMA_VERSION');
  });
});

describe('friendlyPath', () => {
  it('adressiert Tracks und Clips über ihre IDs', () => {
    const p = { compositions: [{ id: 'c', tracks: [{ id: 'music', clips: [{ id: 'song' }] }] }] };
    expect(friendlyPath(p, ['compositions', 0, 'tracks', 0, 'clips', 0, 'volume'])).toBe('composition.c.tracks.music.clips.song.volume');
  });
});

describe('Validator gegen TypeBox als Referenz', () => {
  it('stimmt für zufällige Rect-Nodes mit Value.Check überein', () => {
    const num = fc.oneof(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }), fc.constant('x'));
    const rect = fc.record(
      {
        id: fc.oneof(fc.constant('ok'), fc.constant('1bad')),
        type: fc.constant('rect'),
        width: num,
        height: num,
        opacity: num,
        fill: fc.oneof(fc.constant('#FFAA00'), fc.constant('red'), fc.constant({ $expr: 'time' })),
        cornerRadius: fc.oneof(num, fc.constant([1, 2, 3, 4]), fc.constant([1, 2])),
      },
      { requiredKeys: ['id', 'type'] },
    );
    fc.assert(
      fc.property(rect, (value) => {
        const mine = validateValue(RectNode, value).length === 0;
        expect(mine).toBe(Value.Check(RectNode, value));
      }),
      { numRuns: 500 },
    );
  });
});

describe('JSON Schema', () => {
  it('ist aktuell eingecheckt (FR-3)', () => {
    const file = fileURLToPath(new URL('../openvideo.schema.json', import.meta.url));
    const onDisk: unknown = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk).toEqual(buildJsonSchema());
  });

  it('referenziert Nodes rekursiv über $defs', () => {
    const schema = buildJsonSchema();
    expect(JSON.stringify(schema)).toContain('"#/$defs/Node"');
    expect(JSON.stringify(schema)).not.toContain('x-node');
  });
});

describe('migrateProject', () => {
  it('hebt eine ältere Minor-Version an', () => {
    const { project: p, diagnostics } = migrateProject({ schemaVersion: '1.0.0', compositions: [] }, [], '1.2.0');
    expect(p['schemaVersion']).toBe('1.2.0');
    expect(diagnostics).toEqual([]);
  });

  it('wendet Major-Migrationen an und meldet Verluste', () => {
    const { project: p, diagnostics } = migrateProject(
      { schemaVersion: '0.9.0', scenes: [1] },
      [
        {
          from: '0.9.0',
          to: '1.0.0',
          migrate: (old) => ({
            project: { compositions: old['scenes'] },
            diagnostics: [{ code: 'OV_MIGRATION_LOSS', severity: 'warning', errorClass: 'MigrationError', problem: 'dropped x', suggestions: [] }],
          }),
        },
      ],
      '1.0.0',
    );
    expect(p).toEqual({ compositions: [1], schemaVersion: '1.0.0' });
    expect(diagnostics[0]?.code).toBe('OV_MIGRATION_LOSS');
  });

  it('lehnt Projects ohne Version ab', () => {
    expect(migrateProject({ compositions: [] }).diagnostics[0]?.code).toBe('OV_SCHEMA_VERSION');
  });
});
