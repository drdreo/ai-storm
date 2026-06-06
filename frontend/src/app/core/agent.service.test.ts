/**
 * Tests for AgentService.discussSelection — the bidirectional canvas seam (#13).
 *
 * The behaviour under test: when a session is attached, the current canvas
 * selection is framed and TYPED into the live PTY as an editable prompt (with NO
 * trailing '\r', so it is not auto-submitted) and the terminal is focused. When
 * nothing is attached, or the selection is empty, nothing is sent.
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

function makeService(opts: { attached: boolean; selection: string }): Harness {
  const sendInput = vi.fn();
  const focusTerminal = vi.fn();
  const canvas = { getSelectedText: () => opts.selection };
  const ingestion = {
    isAttached: (_id: string) => opts.attached,
    sendInput,
    focusTerminal,
  };
  const injector = Injector.create({
    providers: [
      { provide: CanvasService, useValue: canvas },
      { provide: BackendService, useValue: {} },
      { provide: IngestionService, useValue: ingestion },
      { provide: WorkspaceService, useValue: {} },
    ],
  });
  const svc = runInInjectionContext(injector, () => new AgentService());
  return { svc, sendInput, focusTerminal };
}

describe('AgentService.discussSelection (#13)', () => {
  let h: Harness;

  describe('attached with a non-empty selection', () => {
    beforeEach(() => {
      h = makeService({ attached: true, selection: 'Cache CRDT ops offline' });
    });

    it('returns true', () => {
      expect(h.svc.discussSelection('ws1')).toBe(true);
    });

    it('types the framed prompt into the PTY with NO trailing carriage return', () => {
      h.svc.discussSelection('ws1');
      expect(h.sendInput).toHaveBeenCalledTimes(1);
      const [id, data] = h.sendInput.mock.calls[0];
      expect(id).toBe('ws1');
      expect(data).toContain('Cache CRDT ops offline');
      expect(data.endsWith('\r')).toBe(false);
      expect(data.endsWith('\n')).toBe(false);
      expect(data.endsWith(' ')).toBe(true);
    });

    it('focuses the terminal after typing the prompt', () => {
      h.svc.discussSelection('ws1');
      expect(h.focusTerminal).toHaveBeenCalledWith('ws1');
    });
  });

  describe('not attached', () => {
    beforeEach(() => {
      h = makeService({ attached: false, selection: 'some notes' });
    });

    it('returns false and sends nothing', () => {
      expect(h.svc.discussSelection('ws1')).toBe(false);
      expect(h.sendInput).not.toHaveBeenCalled();
      expect(h.focusTerminal).not.toHaveBeenCalled();
    });
  });

  describe('attached but empty selection', () => {
    beforeEach(() => {
      h = makeService({ attached: true, selection: '   \n  ' });
    });

    it('returns false and sends nothing', () => {
      expect(h.svc.discussSelection('ws1')).toBe(false);
      expect(h.sendInput).not.toHaveBeenCalled();
      expect(h.focusTerminal).not.toHaveBeenCalled();
    });
  });
});
