local EXTENSION_NAME = "Aseprite Codex Bridge"
local EXTENSION_VERSION = "0.1.0"
local STATE_FILE_NAME = "state.json"
local SNAPSHOT_FILE_NAME = "active-sprite.aseprite"

local listeners = {}
local bridgeDir = nil
local stateFile = nil
local snapshotFile = nil

local function now_utc()
  return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

local function normalize_path(path)
  if app.fs and app.fs.normalizePath then
    return app.fs.normalizePath(path)
  end
  return path
end

local function default_bridge_dir()
  local fromEnv = os.getenv("ASEPRITE_MCP_BRIDGE_DIR")
  if fromEnv and fromEnv ~= "" then
    return normalize_path(fromEnv)
  end
  if app.fs and app.fs.tempPath and app.fs.joinPath then
    return normalize_path(app.fs.joinPath(app.fs.tempPath, "aseprite-mcp-bridge"))
  end
  local temp = os.getenv("TEMP") or os.getenv("TMP") or "."
  return normalize_path(temp .. "/aseprite-mcp-bridge")
end

local function ensure_bridge_paths(plugin)
  if bridgeDir then
    return
  end

  if plugin and plugin.preferences then
    plugin.preferences.bridgeDir = plugin.preferences.bridgeDir or default_bridge_dir()
    bridgeDir = normalize_path(plugin.preferences.bridgeDir)
  else
    bridgeDir = default_bridge_dir()
  end

  stateFile = normalize_path(app.fs.joinPath(bridgeDir, STATE_FILE_NAME))
  snapshotFile = normalize_path(app.fs.joinPath(bridgeDir, SNAPSHOT_FILE_NAME))
  app.fs.makeAllDirectories(bridgeDir)
end

local function write_json_file(path, payload)
  app.fs.makeAllDirectories(app.fs.filePath(path))
  local file, err = io.open(path, "w")
  if not file then
    return false, err
  end
  file:write(json.encode(payload))
  file:close()
  return true, nil
end

local function count_items(items)
  local count = 0
  if items then
    for _ in ipairs(items) do
      count = count + 1
    end
  end
  return count
end

local function layer_path(layers, target, prefix)
  if not layers or not target then
    return nil
  end

  for index, layer in ipairs(layers) do
    local current = prefix and (prefix .. "." .. tostring(index)) or tostring(index)
    if layer == target then
      return current
    end
    if layer.isGroup and layer.layers then
      local child = layer_path(layer.layers, target, current)
      if child then
        return child
      end
    end
  end

  return nil
end

local function selection_bounds(sprite)
  if not sprite or not sprite.selection then
    return nil
  end

  local ok, bounds = pcall(function()
    if sprite.selection.isEmpty then
      return nil
    end
    return sprite.selection.bounds
  end)
  if not ok or not bounds then
    return nil
  end

  return {
    x = bounds.x,
    y = bounds.y,
    width = bounds.width,
    height = bounds.height
  }
end

local function active_context()
  local sprite = app.sprite or app.activeSprite
  local layer = app.layer or app.activeLayer
  local frame = app.frame or app.activeFrame
  local tag = app.tag
  local paletteSize = nil

  if sprite and sprite.palettes and sprite.palettes[1] then
    paletteSize = #sprite.palettes[1]
  end

  local frameNumber = nil
  if frame then
    frameNumber = frame.frameNumber or frame
  end

  return {
    sprite = sprite,
    layer = layer,
    frame = frame,
    frameNumber = frameNumber,
    tag = tag,
    paletteSize = paletteSize
  }
end

local function build_state(reason)
  local ctx = active_context()
  local sprite = ctx.sprite
  local spriteState = { exists = sprite ~= nil }
  local activeState = {}

  if sprite then
    spriteState.filePath = sprite.filename or ""
    spriteState.fileName = sprite.filename and app.fs.fileName(sprite.filename) or ""
    spriteState.fileTitle = sprite.filename and app.fs.fileTitle(sprite.filename) or ""
    spriteState.width = sprite.width
    spriteState.height = sprite.height
    spriteState.colorMode = tostring(sprite.colorMode)
    spriteState.frameCount = count_items(sprite.frames)
    spriteState.layerCount = count_items(sprite.layers)
    spriteState.tagCount = count_items(sprite.tags)
    spriteState.sliceCount = count_items(sprite.slices)
    spriteState.paletteSize = ctx.paletteSize
    spriteState.isModified = sprite.isModified
    spriteState.selection = selection_bounds(sprite)

    activeState.layerName = ctx.layer and ctx.layer.name or nil
    activeState.layerPath = layer_path(sprite.layers, ctx.layer, nil)
    activeState.frameNumber = ctx.frameNumber
    activeState.tagName = ctx.tag and ctx.tag.name or nil
  end

  return {
    schemaVersion = 1,
    generatedAt = now_utc(),
    reason = reason or "refresh",
    extension = {
      name = EXTENSION_NAME,
      version = EXTENSION_VERSION
    },
    aseprite = {
      version = tostring(app.version),
      apiVersion = app.apiVersion,
      isUIAvailable = app.isUIAvailable
    },
    bridge = {
      dir = bridgeDir,
      stateFile = stateFile,
      snapshotFile = snapshotFile
    },
    sprite = spriteState,
    active = activeState
  }
end

local function write_state(includeSnapshot, reason, showAlert)
  if app.isUIAvailable == false then
    return false, "Aseprite UI is not available; skipping bridge state write"
  end

  ensure_bridge_paths()

  local state = build_state(reason)
  local sprite = app.sprite or app.activeSprite

  if includeSnapshot and sprite then
    local ok, err = pcall(function()
      sprite:saveCopyAs(snapshotFile)
    end)
    if ok then
      state.sprite.snapshotPath = snapshotFile
      state.sprite.snapshotSavedAt = now_utc()
    else
      state.sprite.snapshotError = tostring(err)
    end
  end

  local ok, err = write_json_file(stateFile, state)
  if showAlert then
    if ok then
      app.alert({
        title = EXTENSION_NAME,
        text = {
          "Bridge state written.",
          stateFile
        }
      })
    else
      app.alert({
        title = EXTENSION_NAME,
        text = {
          "Failed to write bridge state.",
          tostring(err)
        }
      })
    end
  end

  return ok, err
end

local function show_status_dialog()
  ensure_bridge_paths()
  local ctx = active_context()
  local spritePath = "(no active sprite)"
  if ctx.sprite and ctx.sprite.filename and ctx.sprite.filename ~= "" then
    spritePath = ctx.sprite.filename
  elseif ctx.sprite then
    spritePath = "(unsaved active sprite)"
  end

  local dialog = Dialog({
    title = "Codex MCP"
  })
  dialog:label({
    id = "bridge",
    text = "Bridge dir: " .. bridgeDir
  })
  dialog:label({
    id = "state",
    text = "State file: " .. stateFile
  })
  dialog:label({
    id = "sprite",
    text = "Sprite: " .. spritePath
  })
  dialog:button({
    id = "refresh",
    text = "Refresh Context",
    onclick = function()
      write_state(false, "status-dialog-refresh", false)
    end
  })
  dialog:button({
    id = "snapshot",
    text = "Save Snapshot",
    onclick = function()
      write_state(true, "status-dialog-snapshot", false)
    end
  })
  dialog:button({
    id = "review",
    text = "Prepare Review Pack",
    onclick = function()
      write_state(true, "status-dialog-review-pack", false)
    end
  })
  dialog:button({
    id = "close",
    text = "Close",
    onclick = function()
      dialog:close()
    end
  })
  dialog:show({
    wait = false
  })
end

local function listen(eventName, callback)
  if not app.events then
    return
  end
  local ok, code = pcall(function()
    return app.events:on(eventName, callback)
  end)
  if ok and code then
    table.insert(listeners, code)
  end
end

function init(plugin)
  if app.isUIAvailable == false then
    return
  end

  ensure_bridge_paths(plugin)

  local menuGroup = "codex_mcp_bridge_group"
  local commandGroup = "sprite_crop"
  if plugin.newMenuGroup then
    local ok = pcall(function()
      plugin:newMenuGroup({
        id = menuGroup,
        title = "Codex MCP",
        group = "sprite_crop"
      })
    end)
    if ok then
      commandGroup = menuGroup
    end
  end

  plugin:newCommand({
    id = "CodexMcpRefreshContext",
    title = "Refresh Context",
    group = commandGroup,
    onclick = function()
      write_state(false, "manual-refresh", true)
    end
  })

  plugin:newCommand({
    id = "CodexMcpSaveSnapshot",
    title = "Save Active Snapshot",
    group = commandGroup,
    onclick = function()
      write_state(true, "manual-snapshot", true)
    end,
    onenabled = function()
      return (app.sprite or app.activeSprite) ~= nil
    end
  })

  plugin:newCommand({
    id = "CodexMcpPrepareReviewPackContext",
    title = "Prepare Review Pack Context",
    group = commandGroup,
    onclick = function()
      write_state(true, "manual-review-pack", true)
    end,
    onenabled = function()
      return (app.sprite or app.activeSprite) ~= nil
    end
  })

  plugin:newCommand({
    id = "CodexMcpShowStatus",
    title = "Show Bridge Status",
    group = commandGroup,
    onclick = show_status_dialog
  })

  listen("sitechange", function()
    write_state(false, "sitechange", false)
  end)

  listen("aftercommand", function(ev)
    local name = ev and ev.name or "unknown"
    write_state(false, "aftercommand:" .. tostring(name), false)
  end)

  write_state(false, "extension-init", false)
end

function exit(plugin)
  if app.isUIAvailable == false then
    return
  end

  for _, code in ipairs(listeners) do
    pcall(function()
      app.events:off(code)
    end)
  end
  write_state(false, "extension-exit", false)
end
