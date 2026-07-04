/**
 * Tests for the focus-mode toggle (#131) in the shared UI store. Pure zustand
 * state, no DOM/tldraw dependency, so it runs in the plain Node test env.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore, ui } from "./ui.store";

describe("focus mode", () => {
  beforeEach(() => {
    useUiStore.setState({ focusMode: false });
  });

  it("starts off", () => {
    expect(useUiStore.getState().focusMode).toBe(false);
  });

  it("toggleFocusMode turns it on, then off again", () => {
    ui.toggleFocusMode();
    expect(useUiStore.getState().focusMode).toBe(true);
    ui.toggleFocusMode();
    expect(useUiStore.getState().focusMode).toBe(false);
  });

  it("setFocusMode sets it directly regardless of current state", () => {
    ui.setFocusMode(true);
    expect(useUiStore.getState().focusMode).toBe(true);
    ui.setFocusMode(true);
    expect(useUiStore.getState().focusMode).toBe(true);
    ui.setFocusMode(false);
    expect(useUiStore.getState().focusMode).toBe(false);
  });
});
