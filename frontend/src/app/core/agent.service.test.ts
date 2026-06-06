/**
 * Tests for AgentService.discussText — the bidirectional canvas seam (#13).
 *
 * The behaviour under test: when a session is attached, the supplied card text
 * is framed and TYPED into the live PTY as an editable prompt (with NO trailing
 * '\r', so it is not auto-submitted) and the terminal is focused. When nothing
 * is attached, or the text is empty, nothing is sent. The text is now passed in
 * by the caller (the canvas service serializes the selected idea card), so the
 * service no longer reads the editor selection itself.
 *
 * Heavy collaborators (BlockSuite canvas, the WebSocket backend) are mocked so
 * the service runs in the plain Node test env; it is built inside a minimal
 * injector (no DOM / TestBed), mirroring ingestion.service.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

// Replace modules that would otherwise pull in BlockSuite / a real socket.
vi.mock('./canvas.service', () => ({ CanvasService: class {} }));
vi.mock('./backend.service', () => ({ BackendService: class {} }));
vi.mock('./ingestion.service', () => ({ IngestionService: class {} }));
vi.mock('./workspace.service', () => ({ WorkspaceService: class {} }));

import { AgentService } from './agent.service';
import { CanvasService } from './canvas.service';
import { BackendService } from './backend.service';
import { IngestionService } from './ingestion.service';
import { WorkspaceService } from './workspace.service';

interface Harness {
  svc: AgentService;
  sendInput: ReturnType<typeof vi.fn>;
  focusTerminal: ReturnType<typeof vi.fn>;
}

function makeService(opts: { attached: boolean }): Harness {
  const sendInput = vi.fn();
  const focusTerminal = vi.fn();
  const ingestion = {
    isAttached: (_id: string) => opts.attached,
    sendInput,
    focusTerminal,
  };
  const injector = Injector.create({
    providers: [
      // Text is supplied to discussText directly — no canvas selection read.
      { provide: CanvasService, useValue: {} },
      { provide: BackendService, useValue: {} },
      { provide: IngestionService, useValue: ingestion },
      { provide: WorkspaceService, useValue: {} },
    ],
  });
  const svc = runInInjectionContext(injector, () => new AgentService());
  return { svc, sendInput, focusTerminal };
}

describe('AgentService.discussText (#13)', () => {
  let h: Harness;

  describe('attached with non-empty text', () => {
    beforeEach(() => {
      h = makeService({ attached: true });
    });

    it('returns true', () => {
      expect(h.svc.discussText('ws1', 'Cache CRDT ops offline')).toBe(true);
    });

    it('types the framed prompt into the PTY with NO trailing carriage return', () => {
      h.svc.discussText('ws1', 'Cache CRDT ops offline');
      expect(h.sendInput).toHaveBeenCalledTimes(1);
      const [id, data] = h.sendInput.mock.calls[0];
      expect(id).toBe('ws1');
      expect(data).toContain('Cache CRDT ops offline');
      expect(data.endsWith('\r')).toBe(false);
      expect(data.endsWith('\n')).toBe(false);
      expect(data.endsWith(' ')).toBe(true);
    });

    it('focuses the terminal after typing the prompt', () => {
      h.svc.discussText('ws1', 'Cache CRDT ops offline');
      expect(h.focusTerminal).toHaveBeenCalledWith('ws1');
    });
  });

  describe('not attached', () => {
    beforeEach(() => {
      h = makeService({ attached: false });
    });

    it('returns false and sends nothing', () => {
      expect(h.svc.discussText('ws1', 'some notes')).toBe(false);
      expect(h.sendInput).not.toHaveBeenCalled();
      expect(h.focusTerminal).not.toHaveBeenCalled();
    });
  });

  describe('attached but empty text', () => {
    beforeEach(() => {
      h = makeService({ attached: true });
    });

    it('returns false and sends nothing', () => {
      expect(h.svc.discussText('ws1', '   \n  ')).toBe(false);
      expect(h.sendInput).not.toHaveBeenCalled();
      expect(h.focusTerminal).not.toHaveBeenCalled();
    });
  });
});
