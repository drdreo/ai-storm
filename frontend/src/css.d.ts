/**
 * Ambient declaration for side-effect CSS imports (e.g. `import 'tldraw/tldraw.css'`
 * in the canvas island). The Angular esbuild builder bundles the CSS; this only
 * tells the type-checker the module is import-able with no exports.
 */
declare module '*.css';
