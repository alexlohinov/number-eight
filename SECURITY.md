# Security

## Supported platforms

No. 8 currently ships for macOS on Apple Silicon (`aarch64`) and Intel
(`x86_64`). Linux is not a supported build or release target.

## RUSTSEC-2024-0429

- Package: `glib 0.18.5`
- Relationship: transitive dependency
- Source: Tauri `2.11.5` and Wry `0.55.1` through the Linux-only GTK3
  (`gtk 0.18.2`) and WebKitGTK (`webkit2gtk 2.0.2`) backend
- macOS runtime exposure: none; `glib` is absent from both supported macOS
  target dependency graphs

RustSec currently identifies `glib >=0.20.0` as patched, but Tauri/Wry's GTK3
dependency line requires `glib 0.18` and no compatible upstream backport is
available. The project will monitor the official gtk-rs release line and update
when a compatible fix is published.

Before enabling Linux builds or releases, remove the audit exception and update
the dependency graph to a crate version containing the official fix. Dismissing
the current alert as not used does not mean the affected upstream code is
patched.
