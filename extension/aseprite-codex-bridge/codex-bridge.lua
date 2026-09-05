local EXTENSION_NAME = "Aseprite Codex Bridge"
local EXTENSION_VERSION = "0.1.5"
local SESSION_ID = tostring(os.time()) .. ":" .. tostring({})
local lastHeartbeatAt = 0
local STATE_FILE_NAME = "state.json"
local SNAPSHOT_FILE_NAME = "active-sprite.aseprite"
local SNAPSHOT_REQUEST_FILE_NAME = "snapshot-request.json"
local SNAPSHOT_RESULT_FILE_NAME = "snapshot-result.json"
local SAVE_REQUEST_FILE_NAME = "save-request.json"
local SAVE_RESULT_FILE_NAME = "save-result.json"
local RELOAD_REQUEST_FILE_NAME = "reload-request.json"
local RELOAD_RESULT_FILE_NAME = "reload-result.json"

local listeners = {}
local bridgeDir = nil
local stateFile = nil
local snapshotFile = nil
local snapshotRequestFile = nil
local snapshotResultFile = nil
local saveRequestFile = nil
local saveResultFile = nil
local reloadRequestFile = nil
local reloadResultFile = nil
local reloadTimer = nil
local reloadInProgress = false
local snapshotInProgress = false
local saveInProgress = false
local lastReloadRequestId = nil
local lastSnapshotRequestId = nil
local lastSaveRequestId = nil

local function now_utc()
  return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

local function normalize_path(path)
  if app.fs and app.fs.normalizePath then
    return app.fs.normalizePath(path)
  end
  return path
end

local function comparable_path(path)
  if not path or path == "" then
    return ""
  end
  return string.lower(string.gsub(normalize_path(path), "\\", "/"))
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
  snapshotRequestFile = normalize_path(app.fs.joinPath(bridgeDir, SNAPSHOT_REQUEST_FILE_NAME))
  snapshotResultFile = normalize_path(app.fs.joinPath(bridgeDir, SNAPSHOT_RESULT_FILE_NAME))
  saveRequestFile = normalize_path(app.fs.joinPath(bridgeDir, SAVE_REQUEST_FILE_NAME))
  saveResultFile = normalize_path(app.fs.joinPath(bridgeDir, SAVE_RESULT_FILE_NAME))
  reloadRequestFile = normalize_path(app.fs.joinPath(bridgeDir, RELOAD_REQUEST_FILE_NAME))
  reloadResultFile = normalize_path(app.fs.joinPath(bridgeDir, RELOAD_RESULT_FILE_NAME))
  app.fs.makeAllDirectories(bridgeDir)
end

local function read_json_file(path)
  local file = io.open(path, "r")
  if not file then
    return nil, nil
  end

  local contents = file:read("*a")
  file:close()
  if not contents or contents == "" then
    return nil, "empty file"
  end

  local ok, payload = pcall(function()
    return json.decode(contents)
  end)
  if not ok then
    return nil, tostring(payload)
  end

  return payload, nil
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

local function layer_by_path(layers, path)
  if not layers or not path or path == "" then
    return nil
  end

  local currentLayers = layers
  local currentLayer = nil
  for part in string.gmatch(path, "[^.]+") do
    local index = tonumber(part)
    if not index or not currentLayers or not currentLayers[index] then
      return nil
    end
    currentLayer = currentLayers[index]
    currentLayers = currentLayer.layers
  end

  return currentLayer
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
    sessionId = SESSION_ID,
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
      snapshotFile = snapshotFile,
      snapshotRequestFile = snapshotRequestFile,
      snapshotResultFile = snapshotResultFile,
      saveRequestFile = saveRequestFile,
      saveResultFile = saveResultFile,
      reloadRequestFile = reloadRequestFile,
      reloadResultFile = reloadResultFile
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

  if includeSnapshot and not sprite then
    return false, "No active sprite to snapshot"
  end

  if includeSnapshot and sprite then
    local ok, err = pcall(function()
      sprite:saveCopyAs(snapshotFile)
    end)
    if ok then
      state.sprite.snapshotPath = snapshotFile
      state.sprite.snapshotSavedAt = now_utc()
    else
      state.sprite.snapshotError = tostring(err)
      write_json_file(stateFile, state)
      return false, tostring(err)
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

local save_active_file

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
    id = "save",
    text = "Save Active File",
    onclick = function()
      save_active_file(false, "status-dialog-save-active-file")
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

local function reload_visible_file(showAlert, reason)
  local ctx = active_context()
  local sprite = ctx.sprite

  if not sprite then
    if showAlert then
      app.alert({
        title = EXTENSION_NAME,
        text = "No active sprite to reload."
      })
    end
    return false, "no active sprite"
  end

  if not sprite.filename or sprite.filename == "" then
    if showAlert then
      app.alert({
        title = EXTENSION_NAME,
        text = "Cannot reload an unsaved sprite from disk."
      })
    end
    return false, "active sprite has no filename"
  end

  if sprite.isModified then
    if showAlert then
      app.alert({
        title = EXTENSION_NAME,
        text = "Refusing to reload: active sprite has unsaved edits."
      })
    end
    return false, "active sprite has unsaved edits"
  end

  local filePath = sprite.filename
  local frameNumber = ctx.frameNumber
  local activeLayerPath = layer_path(sprite.layers, ctx.layer, nil)

  local ok, err = pcall(function()
    app.command.CloseFile()
    app.command.OpenFile({
      filename = filePath
    })
  end)

  if not ok then
    if showAlert then
      app.alert({
        title = EXTENSION_NAME,
        text = {
          "Failed to reload active file.",
          tostring(err)
        }
      })
    end
    return false, tostring(err)
  end

  local reopened = app.sprite or app.activeSprite
  if reopened then
    if frameNumber and reopened.frames and reopened.frames[frameNumber] then
      app.frame = reopened.frames[frameNumber]
    end

    local restoredLayer = layer_by_path(reopened.layers, activeLayerPath)
    if restoredLayer then
      app.layer = restoredLayer
    end
  end

  app.refresh()
  write_state(false, reason or "manual-reload-visible-file", false)

  if showAlert then
    app.alert({
      title = EXTENSION_NAME,
      text = {
        "Reloaded active file from disk.",
        filePath
      }
    })
  end

  return true, nil
end

function save_active_file(showAlert, reason)
  local ctx = active_context()
  local sprite = ctx.sprite

  if not sprite then
    if showAlert then
      app.alert({
        title = EXTENSION_NAME,
        text = "No active sprite to save."
      })
    end
    return false, "no active sprite"
  end

  if not sprite.filename or sprite.filename == "" then
    if showAlert then
      app.alert({
        title = EXTENSION_NAME,
        text = "Cannot save active sprite: no filename."
      })
    end
    return false, "active sprite has no filename"
  end

  local filePath = sprite.filename
  local ok, err = pcall(function()
    sprite:saveAs(filePath)
  end)

  if not ok then
    if showAlert then
      app.alert({
        title = EXTENSION_NAME,
        text = {
          "Failed to save active file.",
          tostring(err)
        }
      })
    end
    return false, tostring(err)
  end

  app.refresh()
  write_state(false, reason or "agent-save-active-file", false)

  if showAlert then
    app.alert({
      title = EXTENSION_NAME,
      text = {
        "Saved active file.",
        filePath
      }
    })
  end

  return true, nil
end

local function write_save_result(request, ok, err)
  ensure_bridge_paths()
  local ctx = active_context()
  local sprite = ctx.sprite
  write_json_file(saveResultFile, {
    schemaVersion = 1,
    generatedAt = now_utc(),
    id = request and request.id or nil,
    action = request and request.action or nil,
    ok = ok == true,
    error = err,
    active = {
      frameNumber = ctx.frameNumber,
      layerName = ctx.layer and ctx.layer.name or nil,
      layerPath = sprite and layer_path(sprite.layers, ctx.layer, nil) or nil
    },
    sprite = {
      exists = sprite ~= nil,
      filePath = sprite and sprite.filename or nil,
      isModified = sprite and sprite.isModified or nil
    }
  })
end

local function write_reload_result(request, ok, err)
  ensure_bridge_paths()
  local ctx = active_context()
  local sprite = ctx.sprite
  write_json_file(reloadResultFile, {
    schemaVersion = 1,
    generatedAt = now_utc(),
    id = request and request.id or nil,
    action = request and request.action or nil,
    ok = ok == true,
    error = err,
    active = {
      frameNumber = ctx.frameNumber,
      layerName = ctx.layer and ctx.layer.name or nil,
      layerPath = sprite and layer_path(sprite.layers, ctx.layer, nil) or nil
    },
    sprite = {
      exists = sprite ~= nil,
      filePath = sprite and sprite.filename or nil,
      isModified = sprite and sprite.isModified or nil
    }
  })
end

local function write_snapshot_result(request, ok, err)
  ensure_bridge_paths()
  local ctx = active_context()
  local sprite = ctx.sprite
  write_json_file(snapshotResultFile, {
    schemaVersion = 1,
    generatedAt = now_utc(),
    id = request and request.id or nil,
    action = request and request.action or nil,
    ok = ok == true,
    error = err,
    active = {
      frameNumber = ctx.frameNumber,
      layerName = ctx.layer and ctx.layer.name or nil,
      layerPath = sprite and layer_path(sprite.layers, ctx.layer, nil) or nil
    },
    sprite = {
      exists = sprite ~= nil,
      filePath = sprite and sprite.filename or nil,
      isModified = sprite and sprite.isModified or nil,
      snapshotPath = snapshotFile
    }
  })
end

local function handle_snapshot_request()
  if snapshotInProgress then
    return
  end

  ensure_bridge_paths()
  local request, readErr = read_json_file(snapshotRequestFile)
  if not request then
    if readErr then
      write_snapshot_result({ action = "save-active-snapshot" }, false, "cannot read snapshot request: " .. tostring(readErr))
      pcall(function()
        os.remove(snapshotRequestFile)
      end)
    end
    return
  end

  if request.action ~= "save-active-snapshot" then
    write_snapshot_result(request, false, "unknown snapshot request action: " .. tostring(request.action))
    pcall(function()
      os.remove(snapshotRequestFile)
    end)
    return
  end

  local requestId = request.id and tostring(request.id) or nil
  local acknowledged = read_json_file(snapshotResultFile)
  if requestId and requestId ~= "" and (requestId == lastSnapshotRequestId or (acknowledged and acknowledged.id == requestId)) then
    -- Windows may have held the request open during the first cleanup.
    -- Retry cleanup without replaying the operation.
    pcall(function() os.remove(snapshotRequestFile) end)
    return
  end
  lastSnapshotRequestId = requestId

  pcall(function()
    os.remove(snapshotRequestFile)
  end)

  snapshotInProgress = true
  local ok, success, err = pcall(function()
    local ctx = active_context()
    local sprite = ctx.sprite
    if request.filePath and request.filePath ~= "" then
      local activePath = sprite and sprite.filename or ""
      if comparable_path(activePath) ~= comparable_path(request.filePath) then
        return false, "active file mismatch: " .. tostring(activePath)
      end
    end
    return write_state(true, "agent-snapshot", false)
  end)
  snapshotInProgress = false

  if not ok then
    write_snapshot_result(request, false, tostring(success))
    return
  end

  write_snapshot_result(request, success == true, err)
end

local function handle_save_request()
  if saveInProgress then
    return
  end

  ensure_bridge_paths()
  local request, readErr = read_json_file(saveRequestFile)
  if not request then
    if readErr then
      write_save_result({ action = "save-active-file" }, false, "cannot read save request: " .. tostring(readErr))
      pcall(function()
        os.remove(saveRequestFile)
      end)
    end
    return
  end

  if request.action ~= "save-active-file" then
    write_save_result(request, false, "unknown save request action: " .. tostring(request.action))
    pcall(function()
      os.remove(saveRequestFile)
    end)
    return
  end

  local requestId = request.id and tostring(request.id) or nil
  local acknowledged = read_json_file(saveResultFile)
  if requestId and requestId ~= "" and (requestId == lastSaveRequestId or (acknowledged and acknowledged.id == requestId)) then
    -- Windows may have held the request open during the first cleanup.
    -- Retry cleanup without replaying the operation.
    pcall(function() os.remove(saveRequestFile) end)
    return
  end
  lastSaveRequestId = requestId

  pcall(function()
    os.remove(saveRequestFile)
  end)

  saveInProgress = true
  local ok, success, err = pcall(function()
    local ctx = active_context()
    local sprite = ctx.sprite
    if request.filePath and request.filePath ~= "" then
      local activePath = sprite and sprite.filename or ""
      if comparable_path(activePath) ~= comparable_path(request.filePath) then
        return false, "active file mismatch: " .. tostring(activePath)
      end
    end
    return save_active_file(false, "agent-save-active-file")
  end)
  saveInProgress = false

  if not ok then
    write_save_result(request, false, tostring(success))
    return
  end

  write_save_result(request, success == true, err)
end

local function handle_reload_request()
  if reloadInProgress then
    return
  end

  ensure_bridge_paths()
  local request, readErr = read_json_file(reloadRequestFile)
  if not request then
    if readErr then
      write_reload_result({ action = "reload-visible-file" }, false, "cannot read reload request: " .. tostring(readErr))
      pcall(function()
        os.remove(reloadRequestFile)
      end)
    end
    return
  end

  if request.action ~= "reload-visible-file" then
    write_reload_result(request, false, "unknown reload request action: " .. tostring(request.action))
    pcall(function()
      os.remove(reloadRequestFile)
    end)
    return
  end

  local requestId = request.id and tostring(request.id) or nil
  local acknowledged = read_json_file(reloadResultFile)
  if requestId and requestId ~= "" and (requestId == lastReloadRequestId or (acknowledged and acknowledged.id == requestId)) then
    -- Windows may have held the request open during the first cleanup.
    -- Retry cleanup without replaying the operation.
    pcall(function() os.remove(reloadRequestFile) end)
    return
  end
  lastReloadRequestId = requestId

  pcall(function()
    os.remove(reloadRequestFile)
  end)

  reloadInProgress = true
  local ok, success, err = pcall(function()
    local ctx = active_context()
    local sprite = ctx.sprite
    if request.filePath and request.filePath ~= "" then
      local activePath = sprite and sprite.filename or ""
      if comparable_path(activePath) ~= comparable_path(request.filePath) then
        return false, "active file mismatch: " .. tostring(activePath)
      end
    end
    return reload_visible_file(false, "agent-reload-visible-file")
  end)
  reloadInProgress = false

  if not ok then
    write_reload_result(request, false, tostring(success))
    return
  end

  write_reload_result(request, success == true, err)
end

local function start_reload_timer()
  if reloadTimer then
    return
  end

  local ok, timerOrErr = pcall(function()
    local timer = Timer({
      interval = 0.5,
      ontick = function()
        if os.time() - lastHeartbeatAt >= 2 then
          write_json_file(app.fs.joinPath(bridgeDir, "heartbeat.json"), {
            sessionId = SESSION_ID,
            generatedAt = now_utc()
          })
          lastHeartbeatAt = os.time()
        end
        handle_snapshot_request()
        handle_save_request()
        handle_reload_request()
      end
    })
    timer:start()
    return timer
  end)

  if ok then
    reloadTimer = timerOrErr
  else
    write_reload_result({ action = "reload-visible-file" }, false, "cannot start reload timer: " .. tostring(timerOrErr))
  end
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
    id = "CodexMcpReloadVisibleFile",
    title = "Reload Active File From Disk",
    group = commandGroup,
    onclick = function()
      reload_visible_file(true, "manual-reload-visible-file")
    end,
    onenabled = function()
      local sprite = app.sprite or app.activeSprite
      return sprite ~= nil and sprite.filename ~= nil and sprite.filename ~= ""
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
  write_json_file(app.fs.joinPath(bridgeDir, "heartbeat.json"), {
    sessionId = SESSION_ID,
    generatedAt = now_utc()
  })
  start_reload_timer()
end

function exit(plugin)
  if app.isUIAvailable == false then
    return
  end

  if reloadTimer then
    pcall(function()
      reloadTimer:stop()
    end)
    reloadTimer = nil
  end

  for _, code in ipairs(listeners) do
    pcall(function()
      app.events:off(code)
    end)
  end
  write_state(false, "extension-exit", false)
end
