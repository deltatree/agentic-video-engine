import { describe, expect, it } from 'vitest';
import { importHtml, LOSSY_CODE } from '@agentic-video/importers';
import { problems, validateImport } from './helpers.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SVG = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22/%3E';

const PAGE = `<!doctype html>
<html>
<head>
  <title>Card</title>
  <link rel="stylesheet" href="https://fonts.example.com/inter.css">
  <style>.card { background: url('${SVG}') no-repeat; }</style>
</head>
<body>
  <div class="card" style="border-image: url(${PNG}) 30">
    <img src="${PNG}" alt="logo">
    <img src="https://cdn.example.com/photo.jpg" alt="photo">
    <a href="https://example.com">link text only</a>
    <h1>Quarterly results</h1>
  </div>
</body>
</html>`;

describe('importHtml', () => {
  const result = importHtml(PAGE, 'h1 { font: 700 64px Inter; } @import url("https://cdn.example.com/extra.css");', { id: 'card', width: 800, height: 600 });
  const node = result.nodes[0];

  it('produces one schema-valid html node', () => {
    expect(result.nodes).toHaveLength(1);
    expect(node).toMatchObject({ id: 'card', type: 'html', width: 800, height: 600 });
    expect(validateImport(result.nodes, result.assets)).toEqual([]);
  });

  it('keeps the body markup and moves head styles into css', () => {
    const html = String(node?.['html']);
    expect(html).toContain('<h1>Quarterly results</h1>');
    expect(html).not.toContain('<head>');
    const css = String(node?.['css']);
    expect(css).toContain('.card { background: url(\'/assets/card-svg-1\') no-repeat; }');
    expect(css).toContain('h1 { font: 700 64px Inter; }');
  });

  it('turns data URIs into assets served under /assets/<id>', () => {
    const html = String(node?.['html']);
    expect(html).toContain('<img src="/assets/card-image-2" alt="logo">');
    expect(html).toContain('border-image: url(/assets/card-image-1) 30');
    expect(node?.['assets']).toEqual(['card-image-1', 'card-image-2', 'card-svg-1']);
    expect(result.assets.map((a) => a.asset)).toMatchObject([
      { id: 'card-image-1', type: 'image', src: 'assets/card-image-1.png' },
      { id: 'card-image-2', type: 'image', src: 'assets/card-image-2.png' },
      { id: 'card-svg-1', type: 'svg', src: 'assets/card-svg-1.svg' },
    ]);
    expect(new TextDecoder().decode(result.assets[2]?.bytes)).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
  });

  it('reports every external resource, but not plain links', () => {
    expect(result.diagnostics.every((d) => d.code === LOSSY_CODE && d.severity === 'warning')).toBe(true);
    const list = problems(result.diagnostics);
    expect(list).toHaveLength(3);
    expect(list.some((p) => p.includes('head > link') && p.includes('fonts.example.com'))).toBe(true);
    expect(list.some((p) => p.includes('img[src]') && p.includes('photo.jpg'))).toBe(true);
    expect(list.some((p) => p.startsWith('css') && p.includes('extra.css'))).toBe(true);
    expect(result.diagnostics[0]?.suggestions[0]).toContain('import it as an asset');
  });

  it('passes fragments through unchanged', () => {
    const fragment = importHtml('<p>Hi</p>');
    expect(fragment.nodes).toEqual([{ id: 'html', type: 'html', width: 1920, height: 1080, html: '<p>Hi</p>' }]);
    expect(fragment.diagnostics).toEqual([]);
  });
});
