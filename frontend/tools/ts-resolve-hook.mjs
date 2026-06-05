// Node module-resolution hook for `node --test` over the ingestion-engine
// sources in src/app/core.
//
// Those sources use extensionless relative imports (e.g. `import { sanitize }
// from "./ansi"`) because they are compiled by the Angular bundler, whose
// "bundler" moduleResolution does not require file extensions. Node's native
// ESM resolver, however, requires an explicit extension, so it cannot follow
// `./ansi` to `./ansi.ts`. This hook fills exactly that gap — when an
// extensionless relative specifier fails to resolve, it retries with `.ts` —
// without us having to edit the application source (which must keep building
// under Angular untouched).
//
// Preloaded via `node --import ./tools/ts-resolve-hook.mjs` from the `test`
// script. Uses synchronous registerHooks so it is active before any test
// module is loaded.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasKnownExt = /\.[cm]?[jt]s$/.test(specifier);
    if (isRelative && !hasKnownExt) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});
