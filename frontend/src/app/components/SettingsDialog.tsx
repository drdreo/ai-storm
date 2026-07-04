import { Sun, Moon, Monitor } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { theme, useThemeStore } from "../stores/theme.store";

/** One choice in a {@link Segmented} control. `swatch` shows an inline color dot. */
interface SegOption<T extends string> {
  value: T;
  label: string;
  icon?: typeof Sun;
  swatch?: string;
}

/**
 * A compact, accessible segmented control (`role="radiogroup"`). The single UI
 * primitive every appearance knob below renders into, so adding a knob is one
 * options array + one {@link SettingsRow}.
 */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: readonly SegOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border bg-muted/40 p-0.5">
      {options.map(({ value: v, label: l, icon: Icon, swatch }) => {
        const active = value === v;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            title={l}
            onClick={() => onChange(v)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {swatch && <span className="size-3 rounded-full ring-1 ring-black/10" style={{ background: swatch }} />}
            {Icon && <Icon className="size-3.5" />}
            {l}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled section inside the settings dialog — the unit each knob slots into. */
function SettingsRow({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="grid gap-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * App settings (#77). One dialog gathering the global, cross-project appearance
 * knobs — five independent axes (mode, color, font, radius, density, contrast)
 * the user mixes freely. Per-project terminal settings stay in the ControlHub.
 * Controlled by the sidebar footer trigger.
 */
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const s = useThemeStore();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Appearance preferences for this device.</DialogDescription>
        </DialogHeader>

        <div className="divide-y">
          <SettingsRow title="Appearance" description="Light, dark, or follow your system.">
            <Segmented
              label="Appearance"
              value={s.mode}
              onChange={theme.set}
              options={[
                { value: "light", label: "Light", icon: Sun },
                { value: "dark", label: "Dark", icon: Moon },
                { value: "system", label: "System", icon: Monitor }
              ]}
            />
          </SettingsRow>

          <SettingsRow title="Color theme" description="Accent and neutral palette.">
            <Segmented
              label="Color theme"
              value={s.palette}
              onChange={theme.setPalette}
              options={[
                { value: "slate", label: "Slate", swatch: "oklch(0.52 0.18 274)" },
                { value: "ember", label: "Ember", swatch: "oklch(0.62 0.2 34)" }
              ]}
            />
          </SettingsRow>

          <SettingsRow title="Font" description="The interface typeface.">
            <Segmented
              label="Font"
              value={s.font}
              onChange={theme.setFont}
              options={[
                { value: "grotesque", label: "Grotesque" },
                { value: "humanist", label: "Humanist" },
                { value: "mono", label: "Mono" }
              ]}
            />
          </SettingsRow>

          <SettingsRow title="Corners" description="How rounded surfaces are.">
            <Segmented
              label="Corners"
              value={s.radius}
              onChange={theme.setRadius}
              options={[
                { value: "sharp", label: "Sharp" },
                { value: "default", label: "Default" },
                { value: "round", label: "Round" }
              ]}
            />
          </SettingsRow>

          <SettingsRow title="Density" description="Spacing throughout the app.">
            <Segmented
              label="Density"
              value={s.density}
              onChange={theme.setDensity}
              options={[
                { value: "compact", label: "Compact" },
                { value: "comfortable", label: "Comfortable" }
              ]}
            />
          </SettingsRow>

          <SettingsRow title="Contrast" description="Boost text and border contrast.">
            <Segmented
              label="Contrast"
              value={s.contrast}
              onChange={theme.setContrast}
              options={[
                { value: "normal", label: "Normal" },
                { value: "high", label: "High" }
              ]}
            />
          </SettingsRow>
        </div>
      </DialogContent>
    </Dialog>
  );
}
