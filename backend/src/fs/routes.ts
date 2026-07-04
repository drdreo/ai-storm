/**
 * Minimal read-only directory browser (#152) backing the working-directory
 * picker in the session setup UI. The browser can't see the OS filesystem or
 * know the user's home directory, so this gives the frontend just enough to
 * offer a "nice UX" folder picker: list subdirectories of a path, and resolve
 * a sane default (`os.homedir()`) to seed it.
 *
 * Deliberately narrow: directories only (no files), no create/delete/rename,
 * no path outside what `readdir` already exposes to the local user running
 * the backend. This is a local-only tool (server binds to loopback) reflecting
 * the filesystem permissions of whoever started it — same trust boundary as
 * the harness itself, which already runs arbitrary commands in this cwd.
 */

import { Hono } from "hono";
import { homedir } from "node:os";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function fsRoutes() {
  const app = new Hono();

  app.get("/home", (c) => c.json({ home: homedir() }));

  app.get("/list", async (c) => {
    const requested = c.req.query("path");
    const target = resolve(requested && requested.trim() !== "" ? requested : homedir());

    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return c.json({ error: `No such directory: ${target}` }, 404);
      if (code === "ENOTDIR") return c.json({ error: `Not a directory: ${target}` }, 400);
      if (code === "EACCES" || code === "EPERM") return c.json({ error: `Permission denied: ${target}` }, 403);
      return c.json({ error: `Cannot read directory: ${target}` }, 400);
    }

    const entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: resolve(target, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = dirname(target);
    return c.json({ path: target, parent: parent === target ? null : parent, entries });
  });

  return app;
}
