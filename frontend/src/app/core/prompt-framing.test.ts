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

  it('honours the invariants for every verb intent (#15)', () => {
    const intents: PromptIntent[] = ['discuss', 'expand', 'challenge', 'find-risks'];
    for (const intent of intents) {
      const out = framePrompt('Use a CRDT store', intent);
      // Selection embedded verbatim, trailing space, no trailing newline.
      expect(out).toContain('Use a CRDT store');
      expect(out.endsWith(' ')).toBe(true);
      expect(out.endsWith('\n')).toBe(false);
      // Empty selection still yields nothing regardless of intent.
      expect(framePrompt('   ', intent)).toBe('');
    }
  });

  it('frames each verb distinctly (#15)', () => {
    const expand = framePrompt('S', 'expand');
    const challenge = framePrompt('S', 'challenge');
    const risks = framePrompt('S', 'find-risks');
    expect(expand).not.toBe(challenge);
    expect(challenge).not.toBe(risks);
    expect(expand).toContain('Expand on this idea');
    expect(challenge).toContain("devil's advocate");
    expect(risks).toContain('risks');
  });
});

describe('framePrompt — source ref injection (#42)', () => {
  it('prepends a tagging directive carrying the source ref', () => {
    const out = framePrompt('Use a CRDT store', 'find-risks', 'a1');
    expect(out).toContain('@a1');
    expect(out).toContain('«IDEA»');
    // The directive leads; the selection + open clause still follow.
    expect(out.indexOf('@a1')).toBeLessThan(out.indexOf('Use a CRDT store'));
  });

  it('keeps the editable-cursor invariant with a ref (trailing space, no newline)', () => {
    const out = framePrompt('S', 'expand', 'a3');
    expect(out.endsWith(' ')).toBe(true);
    expect(out.endsWith('\n')).toBe(false);
  });

  it('is identical to the no-ref form when sourceRef is omitted', () => {
    expect(framePrompt('S', 'discuss')).toBe(framePrompt('S', 'discuss', undefined));
  });

  it('still yields nothing for an empty selection even with a ref', () => {
    expect(framePrompt('   ', 'discuss', 'a1')).toBe('');
  });
});

describe('PROMPT_TEMPLATES', () => {
  const intents: PromptIntent[] = ['discuss', 'expand', 'challenge', 'find-risks'];

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
