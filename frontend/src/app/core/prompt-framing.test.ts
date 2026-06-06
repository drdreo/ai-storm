/**
 * Tests for the pure prompt-framing layer of the bidirectional canvas (#13).
 *
 * The framed prompt is typed into the live PTY as an EDITABLE prompt, so the
 * load-bearing invariants are: empty/whitespace selections produce nothing, the
 * selection is embedded verbatim (trimmed), and every template ends with a
 * trailing space and NO trailing newline so the cursor lands ready to type.
 */

import { describe, it, expect } from 'vitest';
import { framePrompt, PROMPT_TEMPLATES, type PromptIntent } from './prompt-framing';

describe('framePrompt', () => {
  it('returns "" for an empty selection', () => {
    expect(framePrompt('')).toBe('');
  });

  it('returns "" for a whitespace-only selection', () => {
    expect(framePrompt('   \n\t  \n ')).toBe('');
  });

  it('frames a single-line selection, embedding it verbatim', () => {
    const out = framePrompt('Use a CRDT store');
    expect(out).toContain('Use a CRDT store');
    expect(out).toBe("Regarding these notes from the canvas:\n\nUse a CRDT store\n\nLet's discuss: ");
  });

  it('frames a multi-line selection, preserving its internal newlines', () => {
    const selection = '# Goal\n- offline first\n- low latency';
    const out = framePrompt(selection);
    expect(out).toContain(selection);
    expect(out.startsWith('Regarding these notes from the canvas:\n\n# Goal')).toBe(true);
  });

  it('trims the selection before framing (leading/trailing whitespace gone)', () => {
    const out = framePrompt('   hello world   ');
    expect(out).toContain('\n\nhello world\n\n');
    expect(out).not.toContain('   hello world');
  });

  it('ends with a trailing space and NO trailing newline (editable-cursor invariant)', () => {
    const out = framePrompt('anything');
    expect(out.endsWith(' ')).toBe(true);
    expect(out.endsWith('\n')).toBe(false);
    expect(out.endsWith('\n ')).toBe(false);
  });

  it("defaults to the 'discuss' intent", () => {
    expect(framePrompt('x')).toBe(framePrompt('x', 'discuss'));
  });
});

describe('PROMPT_TEMPLATES', () => {
  const intents: PromptIntent[] = ['discuss'];

  it('has an entry per intent that honours the trailing-space-no-newline invariant', () => {
    for (const intent of intents) {
      const out = PROMPT_TEMPLATES[intent]('a selection');
      expect(out).toContain('a selection');
      expect(out.endsWith(' ')).toBe(true);
      expect(out.endsWith('\n')).toBe(false);
    }
  });

  it('discuss frames with the expected scaffold', () => {
    expect(PROMPT_TEMPLATES.discuss('S')).toBe(
      "Regarding these notes from the canvas:\n\nS\n\nLet's discuss: ",
    );
  });
});
