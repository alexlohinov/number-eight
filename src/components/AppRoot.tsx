import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { AppShell } from "./AppShell";
import { getAppBootstrap } from "../features/settings/api";
import { normalizeBootstrap } from "../features/settings/settingsModel";
import type { AppBootstrap } from "../features/settings/types";

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : "No. 8 could not render." };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("No. 8 render error", error instanceof Error ? error.stack : error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="grid h-full place-items-center bg-background-2 p-8 text-primary">
          <div className="max-w-md rounded-xl border border-border-1 bg-background-1 p-5">
            <h1 className="font-semibold">No. 8 couldn’t render</h1>
            <p className="mt-2 text-secondary">{this.state.error}</p>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

export function AppRoot() {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getAppBootstrap()
      .then((value) => {
        if (active) setBootstrap(normalizeBootstrap(value));
      })
      .catch((reason: unknown) => {
        if (active) setError(typeof reason === "string" ? reason : "No. 8 could not start.");
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <main className="grid h-full place-items-center bg-background-2 p-8 text-primary">
        <div className="max-w-md rounded-xl border border-border-1 bg-background-1 p-5">
          <h1 className="font-semibold">No. 8 couldn’t start</h1>
          <p className="mt-2 text-secondary">{error}</p>
        </div>
      </main>
    );
  }
  if (!bootstrap) return <div className="h-full bg-background-2" />;
  return <AppErrorBoundary><AppShell bootstrap={bootstrap} /></AppErrorBoundary>;
}
