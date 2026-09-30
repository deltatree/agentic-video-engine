/**
 * Skript-Hinweis der Agent API (ADR 0008, Story 16.1 / N6): HTML-Entities tarnen keine Skripte.
 */
import { describe, expect, it } from 'vitest';
import { containsScripts, decodeHtmlEntities } from '@agentic-video/agent';

function projectWith(html: Record<string, unknown>): Record<string, unknown> {
  return { compositions: [{ id: 'main', nodes: [{ id: 'h', type: 'html', ...html }] }] };
}

describe('decodeHtmlEntities', () => {
  it('dekodiert benannte, dezimale und hexadezimale Entities, auch ohne Semikolon', () => {
    expect(decodeHtmlEntities('&lt;script&gt;')).toBe('<script>');
    expect(decodeHtmlEntities('&#60;img&#x2F;onerror=x&#62;')).toBe('<img/onerror=x>');
    expect(decodeHtmlEntities('javascript&colon;alert(1)')).toBe('javascript:alert(1)');
    expect(decodeHtmlEntities('&#106&#97&#118&#97')).toBe('java');
    expect(decodeHtmlEntities('&amp;lt;script&amp;gt;')).toBe('<script>');
  });

  it('lässt unbekannte und ungültige Entities stehen', () => {
    expect(decodeHtmlEntities('&unknown; &#0; &#x110000;')).toBe('&unknown; &#0; &#x110000;');
  });
});

describe('containsScripts erkennt getarnte Skripte (N6)', () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ['<script> als Entities', { html: '&lt;script&gt;alert(1)&lt;/script&gt;' }],
    ['numerische Entities', { html: '&#60;script&#62;alert(1)&#60;/script&#62;' }],
    ['Event-Handler mit kodiertem Schrägstrich', { html: '<img&#x2F;onerror=alert(1) src=x>' }],
    ['javascript: mit &colon;', { html: '<a href="javascript&colon;alert(1)">x</a>' }],
    ['javascript: mit Tab-Entity', { html: '<a href="java&#9;script:alert(1)">x</a>' }],
    ['doppelt kodiert', { html: '&amp;lt;script&amp;gt;' }],
  ];
  for (const [name, fields] of cases) {
    it(name, () => {
      expect(containsScripts(projectWith(fields))).toEqual(['h']);
    });
  }

  it('meldet harmloses HTML mit Entities nicht', () => {
    expect(containsScripts(projectWith({ html: '<p>1 &lt; 2 &amp;&amp; 3 &gt; 2 &mdash; on sale</p>' }))).toEqual([]);
  });
});
