#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMermaidSVG, THEMES } from "beautiful-mermaid";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "docs/media/architecture.mmd");
const outputPath = resolve(root, "docs/media/architecture.svg");
const source = readFileSync(sourcePath, "utf8");

const svg = renderMermaidSVG(source, {
  ...THEMES["github-dark"],
  font: "Inter",
  padding: 48,
  nodeSpacing: 40,
  layerSpacing: 56,
  componentSpacing: 32,
  thoroughness: 7
})
  // Generated docs must render offline and through GitHub's image proxy.
  .replace(/\s*@import url\([^\n]+\);\r?\n/u, "\n")
  .replace(
    "text { font-family: 'Inter', system-ui, sans-serif; }",
    "text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }"
  );

writeFileSync(outputPath, `${svg}\n`, "utf8");
console.log("Rendered docs/media/architecture.svg from docs/media/architecture.mmd (github-dark).");
