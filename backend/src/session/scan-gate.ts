/**
 * `ScanGate` — the shared WHEN-to-scan policy for the idea/score capture scan
 * (the "scanner hardening" complement to mcp-idea-capture §2 non-goals / §7;
 * fixes failure mode §1.1, mid-repaint captures).
 *
 * The scanners (`IdeaScanner` / `ScoreScanner`) decide WHAT a capture means;
 * this class decides WHEN a capture is worth scanning. One timing policy, two
 * byte sources:
 *
 * - **Windows (node-pty), push mode.** The backend used to scan the rendered
 *   screen after EVERY PTY chunk, so a chunk boundary mid-marker-line produced
 *   a scan of a half-painted frame. Construct with `onScan` and call
 *   {@link activity} after each chunk is applied: the scan runs only once the
 *   stream has been quiet for `quietMs` (a trailing debounce — a repaint burst
 *   coalesces into ONE scan of the settled screen). A `maxIntervalMs` cap
 *   bounds latency during continuous output (a long uninterrupted stream still
 *   surfaces ideas promptly); the partial frames the cap can still catch are
 *   backstopped by the scanner's two-frame confirmation.
 *
 * - **POSIX (tmux), query mode.** The 400 ms `capture-pane` poll keeps its own
 *   cadence; construct WITHOUT `onScan` (no timers are ever armed) and have the
 *   poll tick consult {@link settling} — it skips scanning (but keeps polling
 *   and raw streaming) while a resize is settling.
 *
 * **Resize settle (failure mode §1.2).** `resize()` is a backend-visible event
 * that triggers a full clear-and-repaint at the new width — the single most
 * hostile window for the scan. {@link resized} opens a settle window: no scan
 * until the output has been quiet for `resizeSettleMs` after the LAST chunk
 * following the resize (each {@link activity} while settling extends the
 * deadline). An output-quiet window is used rather than a fixed one because
 * repaint duration varies with conversation length and machine load; quiet is
 * the only signal that the repaint actually finished. The latency cap is
 * suspended while settling — the cap exists for ordinary long streams, whereas
 * a repaint frame is KNOWN to be garbage until quiet; two-frame confirmation
 * still backstops a pathological never-quiet stream.
 *
 * Pure timing, no I/O — unit-tested with fake timers; both backends wire
 * through it so the policy cannot drift between platforms.
 */

export interface ScanGateOptions {
  /** Trailing debounce: scan `quietMs` after the last {@link activity}. */
  quietMs?: number;
  /** Latency cap: during continuous output, scan at least this often. */
  maxIntervalMs?: number;
  /** Quiet window required after a {@link resized} before scanning resumes. */
  resizeSettleMs?: number;
  /**
   * Push-mode scan callback. Omit for query mode (tmux): no timers are armed
   * and the caller polls {@link settling} on its own cadence instead.
   */
  onScan?: () => void;
}

const DEFAULT_QUIET_MS = 175;
const DEFAULT_MAX_INTERVAL_MS = 500;
const DEFAULT_RESIZE_SETTLE_MS = 500;

export class ScanGate {
  readonly #quietMs: number;
  readonly #maxIntervalMs: number;
  readonly #resizeSettleMs: number;
  readonly #onScan?: () => void;

  #timer: NodeJS.Timeout | null = null;
  /** Cap deadline for the current output burst; null when no burst is open. */
  #capDeadline: number | null = null;
  /** Resize settle deadline (epoch ms); 0 when not settling. */
  #settleDeadline = 0;
  #disposed = false;

  constructor(opts: ScanGateOptions = {}) {
    this.#quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
    this.#maxIntervalMs = opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
    this.#resizeSettleMs = opts.resizeSettleMs ?? DEFAULT_RESIZE_SETTLE_MS;
    this.#onScan = opts.onScan;
  }

  /** True while a resize settle window is open (query-mode callers skip scans). */
  get settling(): boolean {
    return Date.now() < this.#settleDeadline;
  }

  /**
   * Note an output chunk. In push mode (re)schedules the scan for `quietMs`
   * after this call, clamped to the burst's `maxIntervalMs` cap; while a resize
   * is settling it instead extends the settle deadline (quiet-after-resize).
   */
  activity(): void {
    if (this.#disposed) return;
    const now = Date.now();
    if (now < this.#settleDeadline) {
      // Repaint still streaming after a resize — push the settle deadline out.
      this.#settleDeadline = now + this.#resizeSettleMs;
      this.#schedule(this.#settleDeadline - now);
      return;
    }
    this.#settleDeadline = 0;
    if (this.#capDeadline === null) this.#capDeadline = now + this.#maxIntervalMs;
    const fireAt = Math.min(now + this.#quietMs, this.#capDeadline);
    this.#schedule(fireAt - now);
  }

  /**
   * Note a pane resize: open the settle window and abandon the current burst's
   * latency cap (a repaint frame is known-garbage; see the class doc). In push
   * mode a scan is scheduled at the settle deadline even if no repaint output
   * follows (a shell that repaints nothing must not stall the next scan).
   */
  resized(): void {
    if (this.#disposed) return;
    this.#settleDeadline = Date.now() + this.#resizeSettleMs;
    this.#capDeadline = null;
    this.#schedule(this.#resizeSettleMs);
  }

  /** Drop any pending scan but stay usable (detach: a reattach re-arms). */
  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#capDeadline = null;
  }

  /** Permanently stop the gate (kill): clears timers; further calls are no-ops. */
  dispose(): void {
    this.cancel();
    this.#disposed = true;
  }

  #schedule(delayMs: number): void {
    if (!this.#onScan) return; // query mode: deadlines only, no timers
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#fire(), Math.max(0, delayMs));
  }

  #fire(): void {
    this.#timer = null;
    this.#capDeadline = null;
    this.#settleDeadline = 0;
    this.#onScan?.();
  }
}
