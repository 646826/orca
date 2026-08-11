---
name: orca-lific
description: >-
  Use Orca's Lific integration to read and update a linked Lific issue, resume
  persistent plans, work with pages/comments/activity, or configure MCP/CLI
  access on the actual local, WSL, SSH, or remote runtime host.
---

# Orca Lific

This is a discovery stub. Load the version-matched guide from the active Orca binary before acting:

```text
ORCA skills get orca-lific
```

Resolve `ORCA` once: use `ORCA_CLI_COMMAND` when set, `orca-dev` in a dev checkout exposing `ORCA_DEV_REPO_ROOT`, `orca-ide` on unmanaged Linux, and `orca` elsewhere.

Configured agent PTYs receive non-secret launch context in `ORCA_LIFIC_PROFILE`, `ORCA_LIFIC_ACCESS_MODE`, `ORCA_LIFIC_PROJECT`, and optionally `ORCA_LIFIC_ISSUE`. Prefer active Lific MCP tools when access mode is `mcp`; use the version-matched `ORCA lific ...` wrapper when it is `cli`.

Do not configure, reconnect, rotate credentials, disconnect, or modify `AGENTS.md` unless the user explicitly requested that mutation.
