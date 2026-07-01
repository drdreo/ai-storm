/**
 * Session readiness checklist (#97) — best-effort checks surfaced in the
 * Control Hub before `Start session`, so common setup mistakes (no backend
 * connection, blank harness command) are caught before launch rather than
 * after a failed spawn. Purely client-side: CWD/harness *resolution* only
 * happens in the backend PTY process (see `backend/src/pty/resolve.ts`), so
 * checks here can only validate presence/shape, not resolvability.
 */

import { getFacilitationMode } from '@ai-storm/shared';
import type { ConnectionState } from '../stores/backend.store';

export type ReadinessSeverity = 'ok' | 'warning' | 'blocking';

export interface ReadinessCheck {
  id: string;
  label: string;
  severity: ReadinessSeverity;
  detail: string;
}

export interface ReadinessInput {
  connState: ConnectionState;
  agentCommand: string | undefined;
  cwd: string | undefined;
  modeId: string | undefined;
  background: string | undefined;
}

export function computeReadiness(input: ReadinessInput): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];

  checks.push(
    input.connState === 'open'
      ? { id: 'connection', label: 'Backend connection', severity: 'ok', detail: 'connected' }
      : input.connState === 'connecting'
        ? {
            id: 'connection',
            label: 'Backend connection',
            severity: 'warning',
            detail: 'connecting — wait before starting',
          }
        : {
            id: 'connection',
            label: 'Backend connection',
            severity: 'blocking',
            detail: 'not connected — a session cannot be launched',
          },
  );

  const harness = (input.agentCommand ?? '').trim();
  checks.push(
    harness
      ? { id: 'harness', label: 'Harness command', severity: 'ok', detail: harness }
      : {
          id: 'harness',
          label: 'Harness command',
          severity: 'blocking',
          detail: 'no harness command set',
        },
  );

  if (input.cwd !== undefined) {
    const cwd = input.cwd.trim();
    checks.push(
      cwd
        ? { id: 'cwd', label: 'Working directory', severity: 'ok', detail: cwd }
        : {
            id: 'cwd',
            label: 'Working directory',
            severity: 'warning',
            detail: 'configured but blank',
          },
    );
  }

  const mode = getFacilitationMode(input.modeId);
  checks.push({
    id: 'mode',
    label: 'Facilitation mode',
    severity: 'ok',
    detail: mode.label,
  });

  const background = (input.background ?? '').trim();
  checks.push(
    background
      ? { id: 'background', label: 'Background context', severity: 'ok', detail: 'set' }
      : {
          id: 'background',
          label: 'Background context',
          severity: 'warning',
          detail: 'empty — fine if intentional',
        },
  );

  return checks;
}

export function hasBlockingIssues(checks: ReadinessCheck[]): boolean {
  return checks.some((c) => c.severity === 'blocking');
}
