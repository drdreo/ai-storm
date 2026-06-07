import { Sun, Moon, Monitor } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { theme, useThemeStore, type ThemeMode } from '../stores/theme.store'

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/** A labelled section inside the settings dialog — the unit future configurables slot into. */
function SettingsRow({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="grid gap-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </div>
      {children}
    </div>
  )
}

/** Three-way segmented control for the app theme (#77). */
function ThemeToggle() {
  const mode = useThemeStore((s) => s.mode)
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg border bg-muted/40 p-0.5">
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = mode === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={label}
            onClick={() => theme.set(value)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * App settings (#77). A single dialog gathering global, cross-workspace
 * preferences — today just Appearance, but the {@link SettingsRow} layout is the
 * extension point for future configurables (per-workspace terminal settings stay
 * in the ControlHub). Controlled by the sidebar footer trigger.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Preferences for this device.</DialogDescription>
        </DialogHeader>

        <div className="divide-y">
          <SettingsRow title="Theme" description="Light, dark, or follow your system.">
            <ThemeToggle />
          </SettingsRow>
        </div>
      </DialogContent>
    </Dialog>
  )
}
