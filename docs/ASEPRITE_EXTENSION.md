# Aseprite Codex Bridge Extension

The Aseprite Codex Bridge is a thin Aseprite extension for smoother Codex MCP workflows.
The MCP server stays outside Aseprite, while the extension writes active editor context to
a shared bridge folder.

## What It Adds

- `Sprite > Codex MCP > Refresh Context`
- `Sprite > Codex MCP > Save Active Snapshot`
- `Sprite > Codex MCP > Prepare Review Pack Context`
- `Sprite > Codex MCP > Show Bridge Status`
- Automatic context refresh on Aseprite site changes and commands
- A shared `state.json` file that the MCP server can read
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
