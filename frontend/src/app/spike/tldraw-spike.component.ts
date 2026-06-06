import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  viewChild,
} from '@angular/core';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { TldrawCanvas } from './tldraw-canvas';

/**
 * Spike (#52): the React↔Angular bridge. This Angular standalone component is the
 * "host" that mounts the React {@link TldrawCanvas} island into a plain `<div>`
 * via React 19's `createRoot`, and tears it down on destroy.
 *
 * The technique is deliberately the *lowest-friction* one: no `@angular/elements`,
 * no web-component wrapper, no Zone bridging (the app is zoneless anyway). React
 * owns the subtree under `#reactHost`; Angular owns everything around it. This is
 * the same boundary BlockSuite already sits behind (a framework-agnostic element
 * Angular never reaches into) — so it fits the existing architecture.
 *
 * It is lazy-loaded (see {@link ../app.component.ts} `?spike=tldraw`) so React +
 * tldraw land in a SEPARATE esbuild chunk, keeping them out of the main bundle and
 * giving a clean bundle-size figure for the comparison.
 */
@Component({
  selector: 'as-tldraw-spike',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="react-host" #reactHost></div>`,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        height: 100%;
        width: 100%;
      }
      .react-host {
        position: absolute;
        inset: 0;
      }
    `,
  ],
})
export class TldrawSpikeComponent implements OnDestroy {
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('reactHost');
  #root: Root | null = null;

  constructor() {
    // Mount once the host <div> is in the DOM. afterNextRender runs only in the
    // browser, never during SSR/build prerender — exactly when React needs a
    // real element to attach to.
    afterNextRender(() => {
      this.#root = createRoot(this.host().nativeElement);
      this.#root.render(createElement(TldrawCanvas));
    });
  }

  ngOnDestroy(): void {
    // Unmount the React tree so tldraw disposes its store/listeners when the
    // Angular component is torn down (workspace switch / spike toggled off).
    this.#root?.unmount();
    this.#root = null;
  }
}
