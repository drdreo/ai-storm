import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { log } from "@/lib/log";

interface ErrorBoundaryProps {
  /** Human-readable label for the crashed section, used in the fallback UI and logs. */
  name: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle crashes in a subtree so one broken section (canvas,
 * terminal, a panel) doesn't take down the whole app. Class component because
 * `componentDidCatch`/`getDerivedStateFromError` have no hook equivalent.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error("error_boundary.caught", {
      boundary: this.props.name,
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined
    });
  }

  retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 px-6 text-center">
        <h2 className="text-sm font-semibold text-foreground">{this.props.name} crashed</h2>
        <p className="max-w-sm text-xs text-muted-foreground">{error.message || "An unexpected error occurred."}</p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={this.retry}>
            <RotateCcw aria-hidden /> Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </div>
      </div>
    );
  }
}
