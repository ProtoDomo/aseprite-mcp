# Aseprite Codex Bridge Extension

The Aseprite Codex Bridge is a thin Aseprite extension for smoother Codex MCP workflows.
The MCP server stays outside Aseprite, while the extension writes active editor context to
a shared bridge folder.

## What It Adds

- `Sprite > Codex MCP > Refresh Context`
- `Sprite > Codex MCP > Save Active Snapshot`
- `Sprite > Codex MCP > Reload Active File From Disk` (refuses unsaved edits)
- `Sprite > Codex MCP > Prepare Review Pack Context`
- `Sprite > Codex MCP > Show Bridge Status`
- Automatic context refresh on Aseprite site changes and commands
- A shared `state.json` file that the MCP server can read
- A session-matched `heartbeat.json`, refreshed every two seconds by extension 0.1.5
- Request/result files for snapshots, saves, and visible-file reloads without desktop clicks
- An optional `active-sprite.aseprite` snapshot for unsaved or in-progress sprites

By default, the bridge folder is:

```text
<system temp>/aseprite-mcp-bridge
```

Set `ASEPRITE_MCP_BRIDGE_DIR` for both Aseprite and the MCP server if you want a
different shared folder.

## MCP Tools Added

- `get_bridge_status`
- `get_active_sprite_context`
- `get_active_sprite_info`
- `save_active_sprite_copy`
- `run_script_on_active_sprite`
- `export_review_pack`
- `compare_template_layers`

These tools remove the need to repeatedly pass sprite paths when Codex should operate on
the currently active Aseprite document. Use `Prepare Review Pack Context` before asking
Codex to audit template/skin work; it saves a fresh snapshot and context state that
`export_review_pack` can resolve without path guessing.

## Package

From the repository root:

```powershell
.\scripts\package-extension.ps1
```

The packaged extension is written to:

```text
dist\aseprite-codex-bridge.aseprite-extension
```

Install it through `Edit > Preferences > Extensions > Add Extension`, then restart
Aseprite if the menu commands are not visible.

## Connection and document identity

Use extension 0.1.5 with the current MCP build. `get_bridge_status.connected` requires
a matching heartbeat no older than ten seconds and a context that has not exited.
`stateAvailable` only indicates that context exists on disk. An old state file does
not prove Aseprite is running. `connectionReason` explains an unavailable bridge.
An idle editor remains connected through its heartbeat; the last canvas event can be old.

Active-file tools require a live bridge and an existing active sprite. An unmodified
saved sprite resolves to its file. A modified or unsaved sprite requires an explicit
snapshot in the current context. A leftover shared snapshot is never used as fallback.
Refresh a snapshot immediately before inspecting unsaved edits. A subsequent context
change can invalidate it. Path-based tools continue working with the editor closed.

`run_script_on_active_sprite` runs a separate **batch Aseprite process** against the
resolved saved file or snapshot. It does not execute in the visible tab. To inspect
unsaved editor pixels, request a snapshot. After external edits to a saved file,
request reload and then snapshot to verify what the editor actually displays.

## Bridge requests

Read the request/result paths from `get_active_sprite_context.state.bridge`.
Write one JSON request at a time, only when no request is pending. Include a unique
`id` and the exact expected `filePath`; the extension rejects a different active file.
Wait for a result with the same `id` and require `ok: true`. Do not treat a previous
result as acknowledgment. Stop after a bounded timeout and do not replay writes.
After acknowledgment, remove only your matching request if it remains. The extension
also checks the persisted result ID to avoid replaying an acknowledged request after
an editor restart. Prefer writing complete JSON to a temporary file before publishing
it as the request; keep callers serialized within each shared bridge directory.

| Request / result field | Action | Effect |
| --- | --- | --- |
| `snapshotRequestFile` / `snapshotResultFile` | `save-active-snapshot` | Saves a copy of current editor pixels; does not save the source |
| `saveRequestFile` / `saveResultFile` | `save-active-file` | Saves the current named document to its existing path |
| `reloadRequestFile` / `reloadResultFile` | `reload-visible-file` | Reopens the saved file, preserving frame/layer; rejects unsaved changes |

Example request: `{"id":"unique-request-id","action":"save-active-snapshot","filePath":"C:/art/sprite.aseprite"}`.
Saving or reloading must be within the user's requested edit scope. The shared bridge
directory is intended for one interactive Aseprite instance per directory.
