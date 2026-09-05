# Codex setup and verification

Configure the MCP in the intended trusted workspace's `.codex/config.toml`, or in
a selected Codex profile. A skill dependency declaration alone does not register a
server. Use verified local paths in this example:

```toml
[mcp_servers.aseprite]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Tools\aseprite-mcp\build\index.js']
startup_timeout_sec = 30.0

[mcp_servers.aseprite.env]
ASEPRITE_PATH = 'C:\Users\Dominik\AppData\Local\Aseprite.v1.3.7\Aseprite.exe'
```

Run `codex mcp get aseprite --json` from the workspace. Project configuration is
loaded only for trusted workspaces. Start a fresh session or restart the MCP/client
after changing registration. The current desktop CLI supports profile files such as
`$CODEX_HOME/creative.config.toml`; use `codex -p creative` for that profile. If the
PATH CLI rejects current config values, use a compatible CLI; do not downgrade
global configuration just to accommodate an old executable.

Official reference: https://developers.openai.com/codex/extend/mcp/

## Acceptance checks

1. `npm run verify`: unit tests, TypeScript build, production dependency audit,
   and extension packaging must all pass.
2. Set `ASEPRITE_PATH`, then run `node scripts/smoke-test.mjs <new-output-directory>`.
   It uses the actual stdio MCP, creates a diagnostic fixture, and checks pixel
   placement, layers, palette, empty animation frames, timing, tags, exports,
   metadata, and save/reopen. The output directory must not already exist.
3. Install the packaged extension and verify a live `get_bridge_status` heartbeat.
   Inspect the intended sprite through `get_active_sprite_context` and
   `get_active_sprite_info`. Test snapshot/save/reload using disposable files and
   the [request protocol](ASEPRITE_EXTENSION.md#bridge-requests).
4. Close Aseprite and require `connected: false` with `extension-exited`.

The integration fixture is a technical diagnostic, not production artwork or a
visual-quality acceptance test. Preserve user documents during verification.
