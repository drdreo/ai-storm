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
    expect(challenge).toContain('stress-test');
    expect(challenge).toContain('stronger version');
    expect(risks).toContain('risks');
  });
});

describe('framePrompt — source ref injection (#42)', () => {
  it('prepends a tagging directive carrying the source ref', () => {
    const out = framePrompt('Use a CRDT store', 'find-risks', 'a1');
    expect(out).toContain('@a1');
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

  it('uses the generic about directive for non-challenge verbs (#42)', () => {
    for (const intent of ['discuss', 'expand', 'find-risks'] as PromptIntent[]) {
      const out = framePrompt('S', intent, 'a1');
      expect(out).toContain('@a1');
      // The about directive supplies the ref; it never asks for a supersede.
      expect(out).not.toContain('@a1!');
    }
  });

  it('NO verb echoes an «IDEA» marker token the backend would re-extract', () => {
    // The directive is echoed onto the terminal and re-scanned for markers, so
    // it must contain NO «IDEA»/<<IDEA token at all (not just not line-leading —
    // terminal wrapping can push any inline token to a row start). The marker
    // grammar is taught by the (never-echoed) priming instead.
    const intents: PromptIntent[] = ['discuss', 'expand', 'challenge', 'find-risks'];
    for (const intent of intents) {
      const out = framePrompt('Use a CRDT store', intent, 'a1');
      expect(out).not.toContain('«IDEA');
      expect(out).not.toContain('<<IDEA');
    }
  });
});

describe('framePrompt — challenge supersede directive (#20/#22, PD-012)', () => {
  it('instructs the supersedes relation via the trailing `!` ref token', () => {
    const out = framePrompt('Use a CRDT store', 'challenge', 'a1');
    // The supersede relation rides the single-line marker via a trailing `!`
    // (the fenced form is unreliable — the TUI renders the fence away, PD-008).
    expect(out).toContain('@a1!');
    expect(out).not.toContain('```idea');
    expect(out).not.toContain('rel: supersedes');
  });

  it('carries the ref but NO «IDEA» marker token (would be re-extracted)', () => {
    const out = framePrompt('Use a CRDT store', 'challenge', 'a1');
    expect(out).toContain('@a1!');
    expect(out).not.toContain('«IDEA');
    expect(out).not.toContain('<<IDEA');
  });

  it('keeps the editable-cursor invariant (trailing space, no newline)', () => {
    const out = framePrompt('S', 'challenge', 'a2');
    expect(out.endsWith(' ')).toBe(true);
    expect(out.endsWith('\n')).toBe(false);
  });

  it('the directive leads; the selection + open clause still follow', () => {
    const out = framePrompt('Use a CRDT store', 'challenge', 'a1');
    expect(out.indexOf('@a1!')).toBeLessThan(out.indexOf('Use a CRDT store'));
  });

  it('does NOT emit the supersede directive without a source ref', () => {
    const out = framePrompt('Use a CRDT store', 'challenge');
    expect(out).not.toContain('@a1!');
    expect(out).not.toContain('«IDEA');
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
