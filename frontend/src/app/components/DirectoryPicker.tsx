import { useEffect, useState } from "react";
import { FolderIcon, FolderOpenIcon, HomeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";

interface DirEntry {
  name: string;
  path: string;
}

interface ListResponse {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

/**
 * Directory picker for the session working directory (#152). The frontend runs
 * in the browser and can't see the local filesystem, so browsing is proxied
 * through the backend's read-only `/api/fs` endpoints (same machine the harness
 * itself will spawn on).
 */
export function DirectoryPicker({
  value,
  onChange,
  disabled
}: {
  value: string | undefined;
  onChange: (path: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (path?: string) => {
    setError(null);
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      const res = await fetch(`/api/fs/list${qs}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Could not list ${path ?? "directory"}`);
        return;
      }
      setListing((await res.json()) as ListResponse);
    } catch {
      setError("Backend unreachable — could not browse directories.");
    }
  };

  useEffect(() => {
    if (open) void load(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 gap-1 font-mono text-xs" disabled={disabled}>
          <FolderOpenIcon className="size-3" />
          Browse
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Choose working directory</DialogTitle>
          <DialogDescription>The harness is launched with this as its working directory.</DialogDescription>
        </DialogHeader>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {listing && (
          <div className="flex flex-col gap-2">
            <div className="truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs" title={listing.path}>
              {listing.path}
            </div>
            <div className="max-h-64 min-h-32 overflow-y-auto rounded-md border">
              {listing.parent && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
                  onClick={() => void load(listing.parent!)}
                >
                  <FolderIcon className="size-3.5 opacity-60" />
                  ..
                </button>
              )}
              {listing.entries.length === 0 && !listing.parent && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No subdirectories.</p>
              )}
              {listing.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
                  onClick={() => void load(entry.path)}
                >
                  <FolderIcon className="size-3.5 opacity-60" />
                  {entry.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button size="sm" variant="ghost" className="gap-1" onClick={() => void load()}>
            <HomeIcon className="size-3.5" />
            Home
          </Button>
          <Button
            size="sm"
            disabled={!listing}
            onClick={() => {
              if (listing) onChange(listing.path);
              setOpen(false);
            }}
          >
            Use this directory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
