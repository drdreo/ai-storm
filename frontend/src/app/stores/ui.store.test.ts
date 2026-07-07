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

describe("debug mode (#219)", () => {
  beforeEach(() => {
    useUiStore.setState({ debugMode: false });
  });

  it("starts off (no localStorage in the Node test env)", () => {
    expect(useUiStore.getState().debugMode).toBe(false);
  });

  it("setDebugMode flips the flag without a localStorage available", () => {
    ui.setDebugMode(true);
    expect(useUiStore.getState().debugMode).toBe(true);
    ui.setDebugMode(false);
    expect(useUiStore.getState().debugMode).toBe(false);
  });
});
