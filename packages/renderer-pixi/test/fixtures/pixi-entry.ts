/**
 * Browser-Einstieg der PixiJS-Tests: erzeugt Test-Bilder im Browser (Blob-URLs), liefert
 * Video-Frames als Canvas und rendert Testfälle.
 */
import { PixiLayerRenderer } from '../../src/index.js';
import { FPS, HEIGHT, PIXI_CASES, WIDTH } from './pixi-cases.js';

async function canvasPng(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Promise<string> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  draw(ctx);
  const blob = await new Promise<Blob | null>((resolve) => {
    c.toBlob(resolve, 'image/png');
  });
  if (blob === null) throw new Error('toBlob failed');
  return URL.createObjectURL(blob);
}

async function createAssets(): Promise<Record<string, string>> {
  return {
    photo: await canvasPng(120, 80, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 120, 80);
      g.addColorStop(0, '#FF6B6B');
      g.addColorStop(0.5, '#FECA57');
      g.addColorStop(1, '#48DBFB');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 120, 80);
      ctx.fillStyle = '#1E2230';
      ctx.beginPath();
      ctx.arc(60, 40, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(10, 10, 20, 20);
    }),
    tiny: await canvasPng(4, 4, (ctx) => {
      const colors = ['#FF6B6B', '#FECA57', '#48DBFB', '#1DD1A1'];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        ctx.fillStyle = colors[(x + y) % 4] ?? '#000';
        ctx.fillRect(x, y, 1, 1);
      }
    }),
    sheet: await canvasPng(160, 80, (ctx) => {
      for (let i = 0; i < 8; i++) {
        const x = (i % 4) * 40;
        const y = Math.floor(i / 4) * 40;
        ctx.fillStyle = `hsl(${String(i * 45)}, 70%, 55%)`;
        ctx.fillRect(x, y, 40, 40);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText(String(i), x + 13, y + 29);
      }
    }),
  };
}

/** Video-Ersatz: ein Canvas, das die Quellzeit als Balken zeigt. */
function videoFrame(_asset: string, seconds: number): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 48;
  const ctx = c.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  ctx.fillStyle = '#222F3E';
  ctx.fillRect(0, 0, 64, 48);
  ctx.fillStyle = '#10AC84';
  ctx.fillRect(0, 36, Math.min(64, seconds * 16), 12);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(Math.min(60, seconds * 16), 4, 4, 28);
  return Promise.resolve(c);
}

function toBase64(bytes: Uint8ClampedArray): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const assetsPromise = createAssets();
const renderer = new PixiLayerRenderer();
const seen: { name: string; seconds: number }[] = [];

async function render(name: string, frame?: number): Promise<{ width: number; height: number; data: string }> {
  const c = PIXI_CASES[name];
  if (c === undefined) throw new Error(`unknown case ${name}`);
  const assets = await assetsPromise;
  await document.fonts.load('700 30px "Inter"');
  const f = frame ?? c.frame ?? 0;
  const canvas = await renderer.render({
    nodes: c.nodes(f),
    width: WIDTH,
    height: HEIGHT,
    scale: c.scale ?? 1,
    frame: f,
    time: f / FPS,
    fps: FPS,
    seed: 1,
    assetUrl: (id) => assets[id] ?? `/missing/${id}`,
    videoFrame: (asset, seconds) => {
      seen.push({ name: asset, seconds });
      return videoFrame(asset, seconds);
    },
    defaultFont: 'Inter',
  });
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  return { width: canvas.width, height: canvas.height, data: toBase64(ctx.getImageData(0, 0, canvas.width, canvas.height).data) };
}

async function renderError(nodes: unknown): Promise<string> {
  try {
    await renderer.render({ nodes: JSON.parse(JSON.stringify(nodes)), width: 10, height: 10, scale: 1, frame: 0, time: 0, fps: FPS, seed: 1, assetUrl: (id) => id, videoFrame, defaultFont: 'Inter' });
    return 'no error';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'diagnostic' in error && typeof error.diagnostic === 'object' && error.diagnostic !== null && 'code' in error.diagnostic) return String(error.diagnostic.code);
    return String(error);
  }
}

Object.assign(window, { ovRender: render, ovRenderError: renderError, ovVideoRequests: seen, ovReady: true });
