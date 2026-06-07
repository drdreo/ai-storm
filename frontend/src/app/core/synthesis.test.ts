/**
 * Tests for the pure board synthesis (#28, PD-015). No tldraw/DOM dependency —
 * runs in the plain Node test env like the other `core/` modules.
 */

import { describe, it, expect } from 'vitest';
import {
  synthesizeBoard,
  summaryToMarkdown,
  STANDALONE_THEME,
  type BoardCard,
  type BoardSnapshot,
} from './synthesis';

function card(id: string, over: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    kind: '',
    title: id,
    body: '',
    starred: false,
    superseded: false,
    origin: 'ai',
    ...over,
  };
}

describe('synthesizeBoard', () => {
  it('reports an empty board', () => {
    const summary = synthesizeBoard({ cards: [], edges: [] });
    expect(summary.isEmpty).toBe(true);
    expect(summary.cardCount).toBe(0);
    expect(summary.themes).toEqual([]);
  });

  it('clusters connected cards into a theme titled by the main idea', () => {
    // a1 is the hub two cards are "about" → it is the main idea of the cluster.
    const snapshot: BoardSnapshot = {
      cards: [
        card('a1', { title: 'Offline-first canvas', kind: 'feature' }),
        card('a2', { title: 'Token leak', kind: 'risk' }),
        card('a3', { title: 'Which store?', kind: 'question' }),
      ],
      edges: [
        { from: 'a2', to: 'a1', relation: 'about' },
        { from: 'a3', to: 'a1', relation: 'about' },
      ],
    };
    const summary = synthesizeBoard(snapshot);
    expect(summary.themes).toHaveLength(1);
    expect(summary.themes[0].title).toBe('Offline-first canvas');
    // Main idea first, then the rest in reading order.
    expect(summary.themes[0].cards.map((c) => c.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('gathers loose cards into a single standalone theme, last', () => {
    const snapshot: BoardSnapshot = {
      cards: [
        card('a1'),
        card('a2'),
        card('b1'),
        card('b2'),
      ],
      edges: [{ from: 'a2', to: 'a1', relation: 'about' }],
    };
    const summary = synthesizeBoard(snapshot);
    expect(summary.themes).toHaveLength(2);
    expect(summary.themes[0].cards).toHaveLength(2); // the real cluster
    const last = summary.themes[summary.themes.length - 1];
    expect(last.title).toBe(STANDALONE_THEME);
    expect(last.cards.map((c) => c.id)).toEqual(['b1', 'b2']);
  });

  it('lifts decisions and open questions out by kind', () => {
    const snapshot: BoardSnapshot = {
      cards: [
        card('a1', { kind: 'decision', title: 'Use IndexedDB' }),
        card('a2', { kind: 'question', title: 'Sync strategy?' }),
        card('a3', { kind: 'feature', title: 'Cards' }),
      ],
      edges: [],
    };
    const summary = synthesizeBoard(snapshot);
    expect(summary.decisions.map((c) => c.id)).toEqual(['a1']);
    expect(summary.openQuestions.map((c) => c.id)).toEqual(['a2']);
  });

  it('reads supersedes edges as resolutions (winner replaces replaced)', () => {
    const snapshot: BoardSnapshot = {
      cards: [
        card('a1', { title: 'Rotate token on attach' }),
        card('a2', { title: 'Long-lived token', superseded: true }),
      ],
      edges: [{ from: 'a1', to: 'a2', relation: 'supersedes' }],
    };
    const summary = synthesizeBoard(snapshot);
    expect(summary.resolutions).toHaveLength(1);
    expect(summary.resolutions[0].winner.id).toBe('a1');
    expect(summary.resolutions[0].replaced.id).toBe('a2');
  });

  it('surfaces starred cards as highlights', () => {
    const snapshot: BoardSnapshot = {
      cards: [card('a1', { starred: true }), card('a2')],
      edges: [],
    };
    expect(synthesizeBoard(snapshot).highlights.map((c) => c.id)).toEqual(['a1']);
  });
});

describe('summaryToMarkdown', () => {
  it('renders an empty-board placeholder', () => {
    const md = summaryToMarkdown(synthesizeBoard({ cards: [], edges: [] }));
    expect(md).toContain('# Board synthesis');
    expect(md).toContain('nothing to synthesize');
  });

  it('renders themes, decisions, open questions and highlights with kind badges', () => {
    const snapshot: BoardSnapshot = {
      cards: [
        card('a1', { title: 'Offline-first canvas', kind: 'feature', body: 'cache ops', starred: true }),
        card('a2', { title: 'Token leak', kind: 'risk' }),
        card('a3', { title: 'Which store?', kind: 'question' }),
        card('a4', { title: 'Use IndexedDB', kind: 'decision' }),
      ],
      edges: [{ from: 'a2', to: 'a1', relation: 'about' }],
    };
    const md = summaryToMarkdown(synthesizeBoard(snapshot));
    expect(md).toContain('## Themes');
    expect(md).toContain('### Offline-first canvas');
    expect(md).toContain('- **✨ Feature: Offline-first canvas** — cache ops');
    expect(md).toContain('## Decisions');
    expect(md).toContain('- **✅ Decision: Use IndexedDB**');
    expect(md).toContain('## Open questions');
    expect(md).toContain('- **❓ Question: Which store?**');
    expect(md).toContain('## Highlights (marked to keep)');
    expect(md).toContain('1 theme');
  });

  it('renders a resolution with a strikethrough on the replaced card', () => {
    const snapshot: BoardSnapshot = {
      cards: [
        card('a1', { title: 'Rotate token on attach' }),
        card('a2', { title: 'Long-lived token', superseded: true }),
      ],
      edges: [{ from: 'a1', to: 'a2', relation: 'supersedes' }],
    };
    const md = summaryToMarkdown(synthesizeBoard(snapshot));
    expect(md).toContain('## Resolved');
    expect(md).toContain('**Rotate token on attach** replaces ~~Long-lived token~~');
  });
});
