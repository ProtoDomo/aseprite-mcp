#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Debug helper — always to stderr so we don't corrupt JSON-RPC on stdout
// ---------------------------------------------------------------------------
const DEBUG = process.env.DEBUG === "true";
function logDebug(msg: string) {
  if (DEBUG) console.error(`[DEBUG] ${msg}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface BridgeState {
  schemaVersion?: number;
  sessionId?: string;
  generatedAt?: string;
  reason?: string;
  bridge?: {
    dir?: string;
    stateFile?: string;
    snapshotFile?: string;
  };
  extension?: Record<string, unknown>;
  aseprite?: Record<string, unknown>;
  sprite?: {
    exists?: boolean;
    filePath?: string;
    snapshotPath?: string;
    [key: string]: unknown;
  };
  active?: Record<string, unknown>;
  error?: string;
}

// Escape a string for safe embedding inside Lua double-quoted strings
export function luaEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

// Normalize file path for Lua (forward slashes, escaped)
export function luaPath(p: string): string {
  return luaEscape(p.replace(/\\/g, "/"));
}
// ---------------------------------------------------------------------------
// Aseprite MCP Server
// ---------------------------------------------------------------------------
export class AsepriteMcpServer {
  private server: Server;
  private asepritePath: string | null = null;
  private toolHandlers: Map<string, ToolHandler> = new Map();

  constructor() {
    this.server = new Server(
      { name: "aseprite-mcp", version: "1.1.0" },
      { capabilities: { tools: {} } },
    );

    this.setupHandlers();

    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  // ---- Path detection -----------------------------------------------------

  private async detectAsepritePath(): Promise<string> {
    if (this.asepritePath) return this.asepritePath;

    const envPath = process.env.ASEPRITE_PATH;
    if (envPath && existsSync(envPath)) {
      this.asepritePath = envPath;
      return envPath;
    }

    const candidates: string[] =
      process.platform === "win32"
        ? [
            "C:\\Program Files\\Aseprite\\Aseprite.exe",
            "C:\\Program Files (x86)\\Aseprite\\Aseprite.exe",
            "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Aseprite\\Aseprite.exe",
            "C:\\Program Files\\Steam\\steamapps\\common\\Aseprite\\Aseprite.exe",
            join(
              process.env.LOCALAPPDATA ?? "",
              "Programs",
              "Aseprite",
              "Aseprite.exe",
            ),
          ]
        : process.platform === "darwin"
          ? [
              "/Applications/Aseprite.app/Contents/MacOS/aseprite",
              join(
                process.env.HOME ?? "",
                "Applications",
                "Aseprite.app",
                "Contents",
                "MacOS",
                "aseprite",
              ),
            ]
          : [
              "/usr/bin/aseprite",
              "/usr/local/bin/aseprite",
              "/snap/bin/aseprite",
              join(
                process.env.HOME ?? "",
                ".local",
                "bin",
                "aseprite",
              ),
            ];

    for (const p of candidates) {
      if (p && existsSync(p)) {
        this.asepritePath = p;
        logDebug(`Detected Aseprite at ${p}`);
        return p;
      }
    }

    // Try PATH
    const cmd = process.platform === "win32" ? "where" : "which";
    const found = await new Promise<string | null>((resolve) => {
      execFile(cmd, ["aseprite"], (err, stdout) => {
        if (err) return resolve(null);
        const line = stdout.trim().split("\n")[0]?.trim();
        resolve(line || null);
      });
    });
    if (found) {
      this.asepritePath = found;
      logDebug(`Found Aseprite on PATH: ${found}`);
      return found;
    }

    throw new Error(
      "Aseprite executable not found. Set ASEPRITE_PATH environment variable.",
    );
  }

  // ---- Lua script runner --------------------------------------------------

  async runLuaScript(
    script: string,
    inputFile?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const aseprite = await this.detectAsepritePath();
    const tmpFile = join(tmpdir(), `aseprite-mcp-${randomUUID()}.lua`);

    const wrappedScript = `
local __ok, __err = pcall(function()
${script}
end)
if not __ok then
  io.write("__RESULT__" .. json.encode({ success = false, error = tostring(__err) }))
end
`;

    try {
      await writeFile(tmpFile, wrappedScript, "utf-8");

      const args = ["-b"];
      if (inputFile) args.push(inputFile);
      args.push("--script", tmpFile);

      logDebug(`Running: ${aseprite} ${args.join(" ")}`);

      const { stdout, stderr } = await new Promise<{
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        execFile(
          aseprite,
          args,
          { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err && !stdout.includes("__RESULT__")) {
              return reject(err);
            }
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
          },
        );
      });

      if (stderr && DEBUG) {
        console.error(`[ASEPRITE STDERR] ${stderr.slice(0, 500)}`);
      }

      const marker = "__RESULT__";
      const idx = stdout.indexOf(marker);
      if (idx === -1) {
        return {
          success: true,
          data: { stdout: stdout.trim(), stderr: stderr.trim() },
        };
      }

      const jsonStr = stdout.slice(idx + marker.length).trim();
      try {
        return JSON.parse(jsonStr);
      } catch {
        return { success: false, error: `Failed to parse result JSON: ${jsonStr.slice(0, 200)}` };
      }
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  }

  async runCliCommand(
    cliArgs: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const aseprite = await this.detectAsepritePath();
    return new Promise((resolve, reject) => {
      execFile(
        aseprite,
        cliArgs,
        { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(err);
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });
  }

  // ---- Response helpers ---------------------------------------------------

  public ok(data: unknown): ToolResult {
    return {
      content: [
        { type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
      ],
    };
  }

  public error(message: string, solutions: string[] = []): ToolResult {
    const parts: { type: "text"; text: string }[] = [
      { type: "text", text: message },
    ];
    if (solutions.length > 0) {
      parts.push({
        type: "text",
        text: "Possible solutions:\n- " + solutions.join("\n- "),
      });
    }
    return { content: parts, isError: true };
  }

  public requireParam(args: Record<string, unknown>, name: string): string {
    const val = args[name] ?? args[this.toSnakeCase(name)] ?? args[this.toCamelCase(name)];
    if (val === undefined || val === null || val === "") {
      throw new Error(`Missing required parameter: ${name}`);
    }
    return String(val);
  }

  public optParam(args: Record<string, unknown>, name: string): string | undefined {
    const val = args[name] ?? args[this.toSnakeCase(name)] ?? args[this.toCamelCase(name)];
    return val !== undefined && val !== null ? String(val) : undefined;
  }

  public numParam(args: Record<string, unknown>, name: string, def?: number): number | undefined {
    const val = args[name] ?? args[this.toSnakeCase(name)] ?? args[this.toCamelCase(name)];
    if (val === undefined || val === null) return def;
    return Number(val);
  }

  public boolParam(args: Record<string, unknown>, name: string, def?: boolean): boolean | undefined {
    const val = args[name] ?? args[this.toSnakeCase(name)] ?? args[this.toCamelCase(name)];
    if (val === undefined || val === null) return def;
    if (typeof val === "boolean") return val;
    return val === "true" || val === "1";
  }

  public toSnakeCase(s: string): string {
    return s.replace(/([A-Z])/g, "_$1").toLowerCase();
  }

  public toCamelCase(s: string): string {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }

  public luaColor(color: unknown): string {
    if (typeof color === "number") return `Color(${color})`;
    if (typeof color === "string") {
      if (color.startsWith("#")) {
        const hex = color.slice(1);
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) : 255;
        return `Color{ r=${r}, g=${g}, b=${b}, a=${a} }`;
      }
      return `Color(${color})`;
    }
    if (typeof color === "object" && color !== null) {
      const c = color as Record<string, number>;
      return `Color{ r=${c.r ?? 0}, g=${c.g ?? 0}, b=${c.b ?? 0}, a=${c.a ?? 255} }`;
    }
    return "Color{ r=0, g=0, b=0, a=255 }";
  }

  public bridgeDir(): string {
    return process.env.ASEPRITE_MCP_BRIDGE_DIR ?? join(tmpdir(), "aseprite-mcp-bridge");
  }

  public bridgeStatePath(): string {
    return join(this.bridgeDir(), "state.json");
  }

  public bridgeSnapshotPath(): string {
    return join(this.bridgeDir(), "active-sprite.aseprite");
  }

  private async readBridgeState(): Promise<{
    state: BridgeState | null;
    statePath: string;
    modifiedAt: string | null;
    connected: boolean;
    connectionReason: string;
    error?: string;
  }> {
    const statePath = this.bridgeStatePath();
    try {
      const [text, info] = await Promise.all([
        readFile(statePath, "utf-8"),
        stat(statePath),
      ]);
      const state = JSON.parse(text) as BridgeState;
      let connected = false;
      let connectionReason = "heartbeat-missing-or-invalid";
      if (state.reason === "extension-exit") {
        connectionReason = "extension-exited";
      } else if (state.sessionId) {
        try {
          const heartbeat = JSON.parse(await readFile(join(this.bridgeDir(), "heartbeat.json"), "utf-8"));
          const ageMs = Date.now() - Date.parse(heartbeat.generatedAt);
          connected = heartbeat.sessionId === state.sessionId && Number.isFinite(ageMs) && ageMs >= -5000 && ageMs <= 10000;
          connectionReason = connected ? "fresh-heartbeat" : "stale-or-mismatched-heartbeat";
        } catch { /* An existing state file alone is not proof of a live editor. */ }
      }
      return {
        state,
        statePath,
        modifiedAt: info.mtime.toISOString(),
        connected,
        connectionReason,
      };
    } catch (err: unknown) {
      return {
        state: null,
        statePath,
        modifiedAt: null,
        connected: false,
        connectionReason: "state-unavailable",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private activeSpriteFileFromState(state: BridgeState | null): {
    filePath: string | null;
    source: "saved" | "snapshot" | null;
  } {
    if (!state?.sprite?.exists || state.reason === "extension-exit") {
      return { filePath: null, source: null };
    }
    const filePath = state?.sprite?.filePath;
    if (!state.sprite.isModified && filePath && existsSync(filePath)) {
      return { filePath, source: "saved" };
    }

    // Only a snapshot explicitly attached to this context may represent unsaved edits.
    // Never fall back to the shared snapshot left behind by another document.
    const snapshotPath = state.sprite.snapshotPath;
    if (snapshotPath && state.sprite.snapshotSavedAt && !state.sprite.snapshotError && existsSync(snapshotPath)) {
      return { filePath: snapshotPath, source: "snapshot" };
    }

    return { filePath: null, source: null };
  }

  private async resolveSpriteFile(args: Record<string, unknown>): Promise<{
    filePath: string;
    source: "argument" | "saved" | "snapshot";
    bridgeGeneratedAt?: string | null;
  }> {
    const filePath = this.optParam(args, "filePath");
    if (filePath) {
      if (!existsSync(filePath)) {
        throw new Error(`Sprite file does not exist: ${filePath}`);
      }
      return { filePath, source: "argument" };
    }

    const bridge = await this.readBridgeState();
    const resolved = this.activeSpriteFileFromState(bridge.connected ? bridge.state : null);
    if (!resolved.filePath || !resolved.source) {
      throw new Error(
        "Missing filePath and no active saved/snapshotted sprite is available from the Aseprite bridge",
      );
    }

    return {
      filePath: resolved.filePath,
      source: resolved.source,
      bridgeGeneratedAt: bridge.state?.generatedAt ?? null,
    };
  }

  private async getSpriteReviewSummary(filePath: string): Promise<Record<string, unknown>> {
    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local tags = {}
for _, tag in ipairs(spr.tags) do
  table.insert(tags, {
    name = tag.name,
    fromFrame = tag.fromFrame.frameNumber,
    toFrame = tag.toFrame.frameNumber,
    aniDir = tostring(tag.aniDir),
    repeats = tag.repeats
  })
end
local layers = {}
for i, layer in ipairs(spr.layers) do
  table.insert(layers, {
    index = i,
    name = layer.name,
    isGroup = layer.isGroup,
    isVisible = layer.isVisible,
    opacity = layer.opacity
  })
end
io.write("__RESULT__" .. json.encode({ success = true, data = {
  width = spr.width,
  height = spr.height,
  frameCount = #spr.frames,
  layerCount = #spr.layers,
  tagCount = #spr.tags,
  tags = tags,
  layers = layers
} }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) {
      throw new Error(result.error ?? "Failed to read sprite review summary");
    }
    return (result.data ?? {}) as Record<string, unknown>;
  }

  private async compareTemplateLayersData(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filePath = this.requireParam(args, "filePath");
    const baseLayerName = this.requireParam(args, "baseLayerName");
    const finalLayerName = this.requireParam(args, "finalLayerName");
    const allowedExpansionPx = this.numParam(args, "allowedExpansionPx", 0)!;
    const centerTolerancePx = this.numParam(args, "centerTolerancePx", 1)!;
    const contactTolerancePx = this.numParam(args, "contactTolerancePx", 0)!;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.findLayerLua("baseLayer", baseLayerName)}
${this.findLayerLua("finalLayer", finalLayerName)}

local allowedExpansionPx = ${allowedExpansionPx}
local centerTolerancePx = ${centerTolerancePx}
local contactTolerancePx = ${contactTolerancePx}

local function key(x, y)
  return tostring(x) .. "," .. tostring(y)
end

local function scan(layer, frame)
  local cel = layer:cel(frame)
  if not cel then
    return {
      missing = true,
      count = 0,
      pixels = {},
      bbox = nil,
      center = nil
    }
  end

  local img = cel.image
  local pixels = {}
  local minx, miny, maxx, maxy = 999999, 999999, -999999, -999999
  local count = 0
  for y = 0, img.height - 1 do
    for x = 0, img.width - 1 do
      local px = img:getPixel(x, y)
      if app.pixelColor.rgbaA(px) > 0 then
        local sx = cel.position.x + x
        local sy = cel.position.y + y
        pixels[key(sx, sy)] = true
        count = count + 1
        if sx < minx then minx = sx end
        if sy < miny then miny = sy end
        if sx > maxx then maxx = sx end
        if sy > maxy then maxy = sy end
      end
    end
  end

  if count == 0 then
    return {
      missing = false,
      count = 0,
      pixels = pixels,
      bbox = nil,
      center = nil
    }
  end

  return {
    missing = false,
    count = count,
    pixels = pixels,
    bbox = { minX = minx, minY = miny, maxX = maxx, maxY = maxy },
    center = { x = (minx + maxx) / 2, y = (miny + maxy) / 2 }
  }
end

local function pixel_diff(a, b)
  local count = 0
  for k, _ in pairs(a) do
    if not b[k] then count = count + 1 end
  end
  return count
end

local function overlap_count(a, b)
  local count = 0
  for k, _ in pairs(a) do
    if b[k] then count = count + 1 end
  end
  return count
end

local frames = {}
local summary = {
  frameCount = #spr.frames,
  missingBaseCels = 0,
  missingFinalCels = 0,
  emptyBaseFrames = 0,
  emptyFinalFrames = 0,
  edgeTouchFrames = 0,
  framesExceedingAllowedExpansion = 0,
  framesExceedingCenterTolerance = 0,
  framesExceedingContactTolerance = 0,
  totalFinalOnlyPixels = 0,
  totalBaseOnlyPixels = 0
}

for i, frame in ipairs(spr.frames) do
  local base = scan(baseLayer, frame)
  local final = scan(finalLayer, frame)
  if base.missing then summary.missingBaseCels = summary.missingBaseCels + 1 end
  if final.missing then summary.missingFinalCels = summary.missingFinalCels + 1 end
  if (not base.missing) and base.count == 0 then summary.emptyBaseFrames = summary.emptyBaseFrames + 1 end
  if (not final.missing) and final.count == 0 then summary.emptyFinalFrames = summary.emptyFinalFrames + 1 end

  local frameResult = {
    frameNumber = i,
    baseMissing = base.missing,
    finalMissing = final.missing,
    basePixelCount = base.count,
    finalPixelCount = final.count,
    baseBbox = base.bbox,
    finalBbox = final.bbox
  }

  if base.bbox and final.bbox then
    local expandLeft = math.max(0, base.bbox.minX - final.bbox.minX)
    local expandRight = math.max(0, final.bbox.maxX - base.bbox.maxX)
    local expandTop = math.max(0, base.bbox.minY - final.bbox.minY)
    local expandBottom = math.max(0, final.bbox.maxY - base.bbox.maxY)
    local maxExpansion = math.max(expandLeft, expandRight, expandTop, expandBottom)
    local centerDriftX = final.center.x - base.center.x
    local centerDriftY = final.center.y - base.center.y
    local contactDriftY = final.bbox.maxY - base.bbox.maxY
    local finalOnly = pixel_diff(final.pixels, base.pixels)
    local baseOnly = pixel_diff(base.pixels, final.pixels)
    local overlap = overlap_count(base.pixels, final.pixels)
    local edgeTouch = final.bbox.minX <= 0 or final.bbox.minY <= 0 or final.bbox.maxX >= spr.width - 1 or final.bbox.maxY >= spr.height - 1
    local expansionOk = maxExpansion <= allowedExpansionPx
    local centerOk = math.abs(centerDriftX) <= centerTolerancePx and math.abs(centerDriftY) <= centerTolerancePx
    local contactOk = math.abs(contactDriftY) <= contactTolerancePx

    frameResult.expansion = {
      left = expandLeft,
      right = expandRight,
      top = expandTop,
      bottom = expandBottom,
      max = maxExpansion,
      withinAllowance = expansionOk
    }
    frameResult.centerDrift = {
      x = centerDriftX,
      y = centerDriftY,
      withinTolerance = centerOk
    }
    frameResult.contactBottomDriftY = contactDriftY
    frameResult.contactWithinTolerance = contactOk
    frameResult.finalOnlyPixels = finalOnly
    frameResult.baseOnlyPixels = baseOnly
    frameResult.overlapPixels = overlap
    frameResult.edgeTouch = edgeTouch

    summary.totalFinalOnlyPixels = summary.totalFinalOnlyPixels + finalOnly
    summary.totalBaseOnlyPixels = summary.totalBaseOnlyPixels + baseOnly
    if edgeTouch then summary.edgeTouchFrames = summary.edgeTouchFrames + 1 end
    if not expansionOk then summary.framesExceedingAllowedExpansion = summary.framesExceedingAllowedExpansion + 1 end
    if not centerOk then summary.framesExceedingCenterTolerance = summary.framesExceedingCenterTolerance + 1 end
    if not contactOk then summary.framesExceedingContactTolerance = summary.framesExceedingContactTolerance + 1 end
  end

  table.insert(frames, frameResult)
end

io.write("__RESULT__" .. json.encode({ success = true, data = {
  filePath = "${luaPath(filePath)}",
  baseLayerName = "${luaEscape(baseLayerName)}",
  finalLayerName = "${luaEscape(finalLayerName)}",
  allowedExpansionPx = allowedExpansionPx,
  centerTolerancePx = centerTolerancePx,
  contactTolerancePx = contactTolerancePx,
  summary = summary,
  frames = frames
} }))
`;

    const result = await this.runLuaScript(script);
    if (!result.success) {
      throw new Error(result.error ?? "Failed to compare template layers");
    }
    return (result.data ?? {}) as Record<string, unknown>;
  }

  // ---- Tool definitions ---------------------------------------------------

  public toolDefinitions() {
    return [
      // ---- Sprite Management ----
      {
        name: "create_sprite",
        description: "Create a new Aseprite sprite file",
        inputSchema: {
          type: "object" as const,
          properties: {
            width: { type: "number", description: "Width in pixels" },
            height: { type: "number", description: "Height in pixels" },
            colorMode: { type: "string", enum: ["rgb", "grayscale", "indexed"], description: "Color mode (default: rgb)" },
            savePath: { type: "string", description: "Path to save the new sprite file" },
          },
          required: ["width", "height", "savePath"],
        },
      },
      {
        name: "open_sprite",
        description: "Open a sprite file and return its metadata",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Path to the sprite file (.aseprite, .ase, .png, etc.)" },
          },
          required: ["filePath"],
        },
      },
      {
        name: "save_sprite",
        description: "Save/convert a sprite to a different format or path",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Source sprite file" },
            savePath: { type: "string", description: "Destination path (format inferred from extension)" },
          },
          required: ["filePath", "savePath"],
        },
      },
      {
        name: "get_sprite_info",
        description: "Get detailed sprite metadata: dimensions, layers, frames, tags, palette, slices",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Path to the sprite file" },
          },
          required: ["filePath"],
        },
      },
      {
        name: "resize_sprite",
        description: "Resize a sprite to new dimensions",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Source sprite file" },
            width: { type: "number", description: "New width in pixels" },
            height: { type: "number", description: "New height in pixels" },
            savePath: { type: "string", description: "Path to save (defaults to overwrite source)" },
          },
          required: ["filePath", "width", "height"],
        },
      },
      {
        name: "crop_sprite",
        description: "Crop a sprite to given bounds",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Source sprite file" },
            x: { type: "number", description: "Left edge" },
            y: { type: "number", description: "Top edge" },
            width: { type: "number", description: "Crop width" },
            height: { type: "number", description: "Crop height" },
            savePath: { type: "string", description: "Path to save (defaults to overwrite source)" },
          },
          required: ["filePath", "x", "y", "width", "height"],
        },
      },

      // ---- Layer Management ----
      {
        name: "add_layer",
        description: "Add a new layer to a sprite",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Name for the new layer" },
            isGroup: { type: "boolean", description: "Create a group layer instead of image layer" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "layerName"],
        },
      },
      {
        name: "remove_layer",
        description: "Remove a layer from a sprite by name",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Name of the layer to remove" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "layerName"],
        },
      },
      {
        name: "list_layers",
        description: "List all layers in a sprite with their properties",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
          },
          required: ["filePath"],
        },
      },
      {
        name: "set_layer_properties",
        description: "Set properties on a layer (visibility, opacity, blend mode, name)",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Layer to modify" },
            newName: { type: "string", description: "Rename the layer" },
            visible: { type: "boolean", description: "Set visibility" },
            opacity: { type: "number", description: "Set opacity (0-255)" },
            blendMode: { type: "string", description: "Set blend mode (normal, multiply, screen, overlay, darken, lighten, color_dodge, color_burn, hard_light, soft_light, difference, exclusion, hue, saturation, color, luminosity)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "layerName"],
        },
      },

      // ---- Frame & Animation ----
      {
        name: "add_frame",
        description: "Add new frame(s) to a sprite",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            count: { type: "number", description: "Number of frames to add (default: 1)" },
            afterFrame: { type: "number", description: "Insert after this frame number (1-indexed). If omitted, appends at end." },
            empty: { type: "boolean", description: "Create empty frames (default: false, copies previous)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath"],
        },
      },
      {
        name: "remove_frame",
        description: "Remove a frame from a sprite",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            frameNumber: { type: "number", description: "Frame number to remove (1-indexed)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "frameNumber"],
        },
      },
      {
        name: "set_frame_duration",
        description: "Set the duration of a frame in milliseconds",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            frameNumber: { type: "number", description: "Frame number (1-indexed)" },
            durationMs: { type: "number", description: "Duration in milliseconds" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "frameNumber", "durationMs"],
        },
      },
      {
        name: "list_frames",
        description: "List all frames in a sprite with durations",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
          },
          required: ["filePath"],
        },
      },

      // ---- Animation Tags ----
      {
        name: "create_tag",
        description: "Create an animation tag on a range of frames",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            tagName: { type: "string", description: "Name for the tag" },
            fromFrame: { type: "number", description: "Start frame (1-indexed)" },
            toFrame: { type: "number", description: "End frame (1-indexed)" },
            aniDir: { type: "string", enum: ["forward", "reverse", "pingpong", "pingpong_reverse"], description: "Animation direction (default: forward)" },
            color: { type: "string", description: "Tag color as hex (#RRGGBB)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "tagName", "fromFrame", "toFrame"],
        },
      },
      {
        name: "remove_tag",
        description: "Remove an animation tag by name",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            tagName: { type: "string", description: "Name of the tag to remove" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "tagName"],
        },
      },
      {
        name: "list_tags",
        description: "List all animation tags in a sprite",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
          },
          required: ["filePath"],
        },
      },

      // ---- Drawing ----
      {
        name: "draw_pixels",
        description: "Draw individual pixels on a specific layer and frame",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Target layer name" },
            frameNumber: { type: "number", description: "Frame number (1-indexed, default: 1)" },
            pixels: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                  color: { description: "Color as hex string (#RRGGBB), palette index, or {r,g,b,a} object" },
                },
                required: ["x", "y", "color"],
              },
              description: "Array of pixels to draw",
            },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "pixels"],
        },
      },
      {
        name: "draw_rect",
        description: "Draw a rectangle on a specific layer and frame",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Target layer name" },
            frameNumber: { type: "number", description: "Frame number (1-indexed, default: 1)" },
            x: { type: "number", description: "Left edge" },
            y: { type: "number", description: "Top edge" },
            width: { type: "number", description: "Rectangle width" },
            height: { type: "number", description: "Rectangle height" },
            color: { description: "Color as hex string (#RRGGBB), palette index, or {r,g,b,a}" },
            filled: { type: "boolean", description: "Fill the rectangle (default: true)" },
            thickness: { type: "number", description: "Stroke thickness in pixels (default: 1). Uses native Aseprite brush when > 1." },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "x", "y", "width", "height", "color"],
        },
      },
      {
        name: "draw_circle",
        description: "Draw a circle on a specific layer and frame",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Target layer name" },
            frameNumber: { type: "number", description: "Frame number (1-indexed, default: 1)" },
            centerX: { type: "number", description: "Center X coordinate" },
            centerY: { type: "number", description: "Center Y coordinate" },
            radius: { type: "number", description: "Circle radius" },
            color: { description: "Color as hex string (#RRGGBB), palette index, or {r,g,b,a}" },
            filled: { type: "boolean", description: "Fill the circle (default: true)" },
            thickness: { type: "number", description: "Stroke thickness in pixels (default: 1). Uses native Aseprite brush when > 1." },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "centerX", "centerY", "radius", "color"],
        },
      },
      {
        name: "draw_line",
        description: "Draw a line between two points on a specific layer and frame",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Target layer name" },
            frameNumber: { type: "number", description: "Frame number (1-indexed, default: 1)" },
            x1: { type: "number", description: "Start X" },
            y1: { type: "number", description: "Start Y" },
            x2: { type: "number", description: "End X" },
            y2: { type: "number", description: "End Y" },
            color: { description: "Color as hex string (#RRGGBB), palette index, or {r,g,b,a}" },
            thickness: { type: "number", description: "Line thickness in pixels (default: 1). Uses native Aseprite brush when > 1." },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "x1", "y1", "x2", "y2", "color"],
        },
      },
      {
        name: "draw_ellipse",
        description: "Draw an ellipse on a specific layer and frame using Aseprite's native ellipse tool",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Target layer name" },
            frameNumber: { type: "number", description: "Frame number (1-indexed, default: 1)" },
            x: { type: "number", description: "Left edge of bounding box" },
            y: { type: "number", description: "Top edge of bounding box" },
            width: { type: "number", description: "Ellipse bounding box width" },
            height: { type: "number", description: "Ellipse bounding box height" },
            color: { description: "Color as hex string (#RRGGBB), palette index, or {r,g,b,a}" },
            filled: { type: "boolean", description: "Fill the ellipse (default: true)" },
            thickness: { type: "number", description: "Stroke thickness in pixels (default: 1)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "x", "y", "width", "height", "color"],
        },
      },
      {
        name: "fill_area",
        description: "Flood fill an area starting from a point using Aseprite's native paint bucket tool",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Target layer name" },
            frameNumber: { type: "number", description: "Frame number (1-indexed, default: 1)" },
            x: { type: "number", description: "X coordinate of the fill starting point" },
            y: { type: "number", description: "Y coordinate of the fill starting point" },
            color: { description: "Fill color as hex string (#RRGGBB), palette index, or {r,g,b,a}" },
            tolerance: { type: "number", description: "Color tolerance for flood fill (0-255, default: 0)" },
            contiguous: { type: "boolean", description: "Only fill contiguous pixels (default: true). If false, fills all matching pixels." },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "x", "y", "color"],
        },
      },
      {
        name: "replace_color",
        description: "Replace all occurrences of one color with another in a sprite",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            fromColor: { description: "Source color to replace (hex, palette index, or {r,g,b,a})" },
            toColor: { description: "Replacement color (hex, palette index, or {r,g,b,a})" },
            layerName: { type: "string", description: "Only replace on this layer (optional, all layers if omitted)" },
            frameNumber: { type: "number", description: "Only replace on this frame (optional, all frames if omitted)" },
            tolerance: { type: "number", description: "Color matching tolerance (0-255, default: 0)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "fromColor", "toColor"],
        },
      },
      {
        name: "flip_sprite",
        description: "Flip the entire sprite canvas horizontally or vertically",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            direction: { type: "string", enum: ["horizontal", "vertical"], description: "Flip direction" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "direction"],
        },
      },
      {
        name: "rotate_sprite",
        description: "Rotate the sprite canvas by 90, 180, or 270 degrees",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            angle: { type: "number", enum: [90, 180, 270], description: "Rotation angle in degrees (clockwise)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "angle"],
        },
      },
      {
        name: "flatten_layers",
        description: "Flatten all layers in a sprite into a single layer",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath"],
        },
      },
      {
        name: "merge_down",
        description: "Merge a layer with the one below it",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Layer to merge down (will merge with layer below)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "layerName"],
        },
      },
      {
        name: "outline",
        description: "Add an outline around non-transparent pixels on a layer",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Target layer name" },
            frameNumber: { type: "number", description: "Frame number (1-indexed, default: 1)" },
            color: { description: "Outline color as hex string (#RRGGBB), palette index, or {r,g,b,a}" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "color"],
        },
      },

      // ---- Palette ----
      {
        name: "get_palette",
        description: "Get all colors in a sprite's palette",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
          },
          required: ["filePath"],
        },
      },
      {
        name: "set_palette_colors",
        description: "Set colors in a sprite's palette",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            colors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  index: { type: "number", description: "Palette index" },
                  r: { type: "number" },
                  g: { type: "number" },
                  b: { type: "number" },
                  a: { type: "number", description: "Alpha (default: 255)" },
                },
                required: ["index", "r", "g", "b"],
              },
              description: "Array of palette entries to set",
            },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "colors"],
        },
      },
      {
        name: "load_palette",
        description: "Load a palette from a file into a sprite",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            palettePath: { type: "string", description: "Path to palette file (.gpl, .pal, .aseprite, .png, etc.)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "palettePath"],
        },
      },
      {
        name: "resize_palette",
        description: "Resize a sprite's palette to a new number of entries",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            newSize: { type: "number", description: "New palette size" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "newSize"],
        },
      },

      // ---- Cel Operations ----
      {
        name: "move_cel",
        description: "Move a cel to a new position",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Layer name" },
            frameNumber: { type: "number", description: "Frame number (1-indexed, default: 1)" },
            x: { type: "number", description: "New X position" },
            y: { type: "number", description: "New Y position" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "layerName", "x", "y"],
        },
      },
      {
        name: "set_cel_opacity",
        description: "Set the opacity of a cel",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Layer name" },
            frameNumber: { type: "number", description: "Frame number (1-indexed, default: 1)" },
            opacity: { type: "number", description: "Opacity (0-255)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "layerName", "opacity"],
        },
      },
      {
        name: "clear_cel",
        description: "Clear (delete) a cel at a specific layer and frame",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            layerName: { type: "string", description: "Layer name" },
            frameNumber: { type: "number", description: "Frame number (1-indexed, default: 1)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "layerName"],
        },
      },

      // ---- Export ----
      {
        name: "export_sprite_sheet",
        description: "Export a sprite as a sprite sheet image with optional JSON data",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Source sprite file" },
            outputImage: { type: "string", description: "Output sprite sheet image path (.png)" },
            dataFile: { type: "string", description: "Output JSON data file path (optional)" },
            sheetType: { type: "string", enum: ["horizontal", "vertical", "rows", "columns", "packed"], description: "Sheet layout type (default: rows)" },
            columns: { type: "number", description: "Fixed number of columns" },
            rows: { type: "number", description: "Fixed number of rows" },
            borderPadding: { type: "number", description: "Padding on texture borders" },
            shapePadding: { type: "number", description: "Padding between frames" },
            innerPadding: { type: "number", description: "Padding inside each frame" },
            trim: { type: "boolean", description: "Trim transparent edges" },
            mergeDuplicates: { type: "boolean", description: "Merge duplicate frames" },
            layer: { type: "string", description: "Export only this layer" },
            tag: { type: "string", description: "Export only this tag" },
            splitLayers: { type: "boolean", description: "Split each layer into separate images" },
          },
          required: ["filePath", "outputImage"],
        },
      },
      {
        name: "export_frame",
        description: "Export a single frame as an image file",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Source sprite file" },
            frameNumber: { type: "number", description: "Frame to export (1-indexed, default: 1)" },
            outputPath: { type: "string", description: "Output image path" },
            layerName: { type: "string", description: "Export only this layer (optional)" },
          },
          required: ["filePath", "outputPath"],
        },
      },
      {
        name: "export_layers",
        description: "Export each layer as a separate image file",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Source sprite file" },
            outputPattern: { type: "string", description: "Output path pattern with {layer} placeholder (e.g. 'output-{layer}.png')" },
            frameNumber: { type: "number", description: "Export this frame only (1-indexed)" },
          },
          required: ["filePath", "outputPattern"],
        },
      },
      {
        name: "export_review_pack",
        description: "Export a review pack for visual audit: 1x sheet, upscaled sheet, grid sheet, GIF, JSON metadata, and optional template comparison",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Source sprite file. If omitted, resolves the active saved/snapshotted sprite from the bridge." },
            outputDir: { type: "string", description: "Directory for generated review files. Defaults to the sprite directory." },
            baseName: { type: "string", description: "Output filename prefix. Defaults to '<sprite-name>-review'." },
            scale: { type: "number", description: "Integer preview scale (default: 8)" },
            columns: { type: "number", description: "Sheet columns. Defaults to tag count when it evenly divides frame count, otherwise sqrt frame count." },
            layer: { type: "string", description: "Export only this layer" },
            includeGif: { type: "boolean", description: "Export upscaled GIF preview (default: true)" },
            includeGrid: { type: "boolean", description: "Export an upscaled sheet with red frame guide grid (default: true)" },
            baseLayerName: { type: "string", description: "Template/base layer for optional comparison" },
            finalLayerName: { type: "string", description: "Final/skin layer for optional comparison" },
            allowedExpansionPx: { type: "number", description: "Allowed per-side silhouette expansion for optional comparison (default: 0)" },
            centerTolerancePx: { type: "number", description: "Allowed bbox-center drift for optional comparison (default: 1)" },
            contactTolerancePx: { type: "number", description: "Allowed bottom/contact drift for optional comparison (default: 0)" },
          },
        },
      },
      {
        name: "compare_template_layers",
        description: "Compare a template/base layer against a final/skin layer and report registration drift, contact drift, silhouette expansion, and pixel overlap",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            baseLayerName: { type: "string", description: "Template/base layer name" },
            finalLayerName: { type: "string", description: "Final/skin layer name" },
            allowedExpansionPx: { type: "number", description: "Allowed per-side silhouette expansion before reporting a frame as over allowance (default: 0)" },
            centerTolerancePx: { type: "number", description: "Allowed bbox-center drift before reporting a frame as over tolerance (default: 1)" },
            contactTolerancePx: { type: "number", description: "Allowed bottom/contact drift before reporting a frame as over tolerance (default: 0)" },
          },
          required: ["filePath", "baseLayerName", "finalLayerName"],
        },
      },

      // ---- Slices ----
      {
        name: "create_slice",
        description: "Create a named slice region in a sprite",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            sliceName: { type: "string", description: "Name for the slice" },
            x: { type: "number", description: "Left edge" },
            y: { type: "number", description: "Top edge" },
            width: { type: "number", description: "Slice width" },
            height: { type: "number", description: "Slice height" },
            pivotX: { type: "number", description: "Pivot X (optional)" },
            pivotY: { type: "number", description: "Pivot Y (optional)" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "sliceName", "x", "y", "width", "height"],
        },
      },
      {
        name: "remove_slice",
        description: "Remove a slice by name",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file" },
            sliceName: { type: "string", description: "Name of the slice to remove" },
            savePath: { type: "string", description: "Path to save" },
          },
          required: ["filePath", "sliceName"],
        },
      },

      // ---- Utility ----
      {
        name: "get_bridge_status",
        description: "Read the Codex Aseprite extension bridge status file, if the extension has written one",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "get_active_sprite_context",
        description: "Read the active sprite, layer, frame, and snapshot context written by the Codex Aseprite extension",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "get_active_sprite_info",
        description: "Get full MCP sprite metadata for the saved or snapshotted sprite currently reported by the extension",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "save_active_sprite_copy",
        description: "Save a copy of the active saved/snapshotted sprite reported by the extension",
        inputSchema: {
          type: "object" as const,
          properties: {
            savePath: { type: "string", description: "Destination path. Defaults to active-sprite-copy.aseprite in the bridge folder" },
          },
        },
      },
      {
        name: "run_script_on_active_sprite",
        description: "Execute Lua with the saved or snapshotted active sprite from the extension opened first",
        inputSchema: {
          type: "object" as const,
          properties: {
            script: { type: "string", description: "Lua script code to execute" },
          },
          required: ["script"],
        },
      },
      {
        name: "run_script",
        description: "Execute an arbitrary Lua script in Aseprite (for advanced operations)",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "Sprite file to open before running (optional)" },
            script: { type: "string", description: "Lua script code to execute" },
          },
          required: ["script"],
        },
      },
      {
        name: "get_aseprite_version",
        description: "Get Aseprite version information",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ];
  }

  // ---- Native tool helpers ------------------------------------------------

  // Generate Lua to set up app.useTool() context (active sprite + layer + frame)
  private useToolSetup(layerName: string | undefined, frameNumber: number): string {
    const layerPart = layerName
      ? `${this.findLayerLua("activeLayer", layerName)}
app.activeLayer = activeLayer`
      : `app.activeLayer = spr.layers[1]`;
    return `
app.activeSprite = spr
${layerPart}
app.activeFrame = spr.frames[${frameNumber}]
`;
  }

  // ---- Tool handler implementations --------------------------------------

  // -- Sprite Management --

  private async handleCreateSprite(args: Record<string, unknown>): Promise<ToolResult> {
    const width = this.numParam(args, "width")!;
    const height = this.numParam(args, "height")!;
    const colorMode = this.optParam(args, "colorMode") ?? "rgb";
    const savePath = this.requireParam(args, "savePath");

    const modeMap: Record<string, string> = { rgb: "ColorMode.RGB", grayscale: "ColorMode.GRAYSCALE", indexed: "ColorMode.INDEXED" };
    const luaMode = modeMap[colorMode] ?? "ColorMode.RGB";

    const script = `
local spr = Sprite(${width}, ${height}, ${luaMode})
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({
  success = true,
  data = {
    width = spr.width,
    height = spr.height,
    colorMode = "${colorMode}",
    path = "${luaPath(savePath)}"
  }
}))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to create sprite");
    return this.ok(result.data ?? result);
  }

  private async handleOpenSprite(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    return this.handleGetSpriteInfo(args);
  }

  private async handleSaveSprite(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const savePath = this.requireParam(args, "savePath");

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to save sprite");
    return this.ok(result.data ?? result);
  }

  private async handleGetSpriteInfo(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end

local function collectLayers(layers, depth)
  local result = {}
  for i, layer in ipairs(layers) do
    local info = {
      name = layer.name,
      isGroup = layer.isGroup,
      isVisible = layer.isVisible,
      isEditable = layer.isEditable,
      opacity = layer.opacity,
      blendMode = tostring(layer.blendMode),
      depth = depth
    }
    if layer.isGroup and layer.layers then
      info.children = collectLayers(layer.layers, depth + 1)
    end
    table.insert(result, info)
  end
  return result
end

local frames = {}
for i, frame in ipairs(spr.frames) do
  table.insert(frames, { frameNumber = frame.frameNumber, duration = math.floor(frame.duration * 1000) })
end

local tags = {}
for i, tag in ipairs(spr.tags) do
  table.insert(tags, {
    name = tag.name,
    fromFrame = tag.fromFrame.frameNumber,
    toFrame = tag.toFrame.frameNumber,
    aniDir = tostring(tag.aniDir),
    repeats = tag.repeats
  })
end

local slices = {}
for i, slice in ipairs(spr.slices) do
  table.insert(slices, {
    name = slice.name,
    bounds = { x = slice.bounds.x, y = slice.bounds.y, width = slice.bounds.width, height = slice.bounds.height }
  })
end

local pal = spr.palettes[1]
local palSize = #pal

io.write("__RESULT__" .. json.encode({
  success = true,
  data = {
    filename = spr.filename,
    width = spr.width,
    height = spr.height,
    colorMode = tostring(spr.colorMode),
    frameCount = #spr.frames,
    layerCount = #spr.layers,
    layers = collectLayers(spr.layers, 0),
    frames = frames,
    tags = tags,
    slices = slices,
    paletteSize = palSize
  }
}))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to get sprite info");
    return this.ok(result.data ?? result);
  }

  private async handleResizeSprite(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const width = this.numParam(args, "width")!;
    const height = this.numParam(args, "height")!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
spr:resize(${width}, ${height})
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { width = spr.width, height = spr.height, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to resize sprite");
    return this.ok(result.data ?? result);
  }

  private async handleCropSprite(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const x = this.numParam(args, "x")!;
    const y = this.numParam(args, "y")!;
    const width = this.numParam(args, "width")!;
    const height = this.numParam(args, "height")!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
spr:crop(${x}, ${y}, ${width}, ${height})
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { width = spr.width, height = spr.height, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to crop sprite");
    return this.ok(result.data ?? result);
  }

  // -- Layer Management --

  private async handleAddLayer(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.requireParam(args, "layerName");
    const isGroup = this.boolParam(args, "isGroup", false);
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const createFn = isGroup ? "spr:newGroup()" : "spr:newLayer()";
    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local layer = ${createFn}
layer.name = "${luaEscape(layerName)}"
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { layerName = layer.name, isGroup = layer.isGroup, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to add layer");
    return this.ok(result.data ?? result);
  }

  private findLayerLua(varName: string, layerName: string): string {
    return `
local function findLayer(layers, name)
  for i, layer in ipairs(layers) do
    if layer.name == name then return layer end
    if layer.isGroup and layer.layers then
      local found = findLayer(layer.layers, name)
      if found then return found end
    end
  end
  return nil
end
local ${varName} = findLayer(spr.layers, "${luaEscape(layerName)}")
if not ${varName} then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Layer not found: ${luaEscape(layerName)}" }))
  return
end
`;
  }

  private async handleRemoveLayer(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.requireParam(args, "layerName");
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.findLayerLua("target", layerName)}
spr:deleteLayer(target)
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { removed = "${luaEscape(layerName)}", savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to remove layer");
    return this.ok(result.data ?? result);
  }

  private async handleListLayers(args: Record<string, unknown>): Promise<ToolResult> {
    return this.handleGetSpriteInfo(args);
  }

  private async handleSetLayerProperties(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.requireParam(args, "layerName");
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const newName = this.optParam(args, "newName");
    const visible = this.boolParam(args, "visible");
    const opacity = this.numParam(args, "opacity");
    const blendMode = this.optParam(args, "blendMode");

    const blendModeMap: Record<string, string> = {
      normal: "BlendMode.NORMAL", multiply: "BlendMode.MULTIPLY", screen: "BlendMode.SCREEN",
      overlay: "BlendMode.OVERLAY", darken: "BlendMode.DARKEN", lighten: "BlendMode.LIGHTEN",
      color_dodge: "BlendMode.COLOR_DODGE", color_burn: "BlendMode.COLOR_BURN",
      hard_light: "BlendMode.HARD_LIGHT", soft_light: "BlendMode.SOFT_LIGHT",
      difference: "BlendMode.DIFFERENCE", exclusion: "BlendMode.EXCLUSION",
      hue: "BlendMode.HSL_HUE", saturation: "BlendMode.HSL_SATURATION",
      color: "BlendMode.HSL_COLOR", luminosity: "BlendMode.HSL_LUMINOSITY",
    };

    let setParts = "";
    if (newName !== undefined) setParts += `  target.name = "${luaEscape(newName)}"\n`;
    if (visible !== undefined) setParts += `  target.isVisible = ${visible}\n`;
    if (opacity !== undefined) setParts += `  target.opacity = ${opacity}\n`;
    if (blendMode !== undefined) {
      const luaBm = blendModeMap[blendMode] ?? "BlendMode.NORMAL";
      setParts += `  target.blendMode = ${luaBm}\n`;
    }

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.findLayerLua("target", layerName)}
app.transaction(function()
${setParts}end)
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = {
  name = target.name,
  isVisible = target.isVisible,
  opacity = target.opacity,
  blendMode = tostring(target.blendMode),
  savedTo = "${luaPath(savePath)}"
} }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to set layer properties");
    return this.ok(result.data ?? result);
  }

  // -- Frame & Animation --

  private async handleAddFrame(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const count = this.numParam(args, "count", 1)!;
    const afterFrame = this.numParam(args, "afterFrame");
    const empty = this.boolParam(args, "empty", false);
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const fn = empty ? "spr:newEmptyFrame" : "spr:newFrame";
    const insertAt = afterFrame !== undefined ? `${afterFrame} + 1` : "#spr.frames + 1";

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
for i = 1, ${count} do
  ${fn}(${insertAt})
end
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { totalFrames = #spr.frames, added = ${count}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to add frame");
    return this.ok(result.data ?? result);
  }

  private async handleRemoveFrame(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const frameNumber = this.numParam(args, "frameNumber")!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
if ${frameNumber} < 1 or ${frameNumber} > #spr.frames then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Frame number out of range" }))
  return
end
spr:deleteFrame(${frameNumber})
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { totalFrames = #spr.frames, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to remove frame");
    return this.ok(result.data ?? result);
  }

  private async handleSetFrameDuration(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const frameNumber = this.numParam(args, "frameNumber")!;
    const durationMs = this.numParam(args, "durationMs")!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
if ${frameNumber} < 1 or ${frameNumber} > #spr.frames then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Frame number out of range" }))
  return
end
spr.frames[${frameNumber}].duration = ${durationMs} / 1000.0
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { frameNumber = ${frameNumber}, durationMs = ${durationMs}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to set frame duration");
    return this.ok(result.data ?? result);
  }

  private async handleListFrames(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local frames = {}
for i, frame in ipairs(spr.frames) do
  table.insert(frames, { frameNumber = frame.frameNumber, durationMs = math.floor(frame.duration * 1000) })
end
io.write("__RESULT__" .. json.encode({ success = true, data = { totalFrames = #spr.frames, frames = frames } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to list frames");
    return this.ok(result.data ?? result);
  }

  // -- Animation Tags --

  private async handleCreateTag(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const tagName = this.requireParam(args, "tagName");
    const fromFrame = this.numParam(args, "fromFrame")!;
    const toFrame = this.numParam(args, "toFrame")!;
    const aniDir = this.optParam(args, "aniDir") ?? "forward";
    const color = this.optParam(args, "color");
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const dirMap: Record<string, string> = {
      forward: "AniDir.FORWARD",
      reverse: "AniDir.REVERSE",
      pingpong: "AniDir.PING_PONG",
      pingpong_reverse: "AniDir.PING_PONG_REVERSE",
    };
    const luaDir = dirMap[aniDir] ?? "AniDir.FORWARD";

    let colorLine = "";
    if (color) colorLine = `tag.color = ${this.luaColor(color)}`;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local tag = spr:newTag(${fromFrame}, ${toFrame})
tag.name = "${luaEscape(tagName)}"
tag.aniDir = ${luaDir}
${colorLine}
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = {
  name = tag.name,
  fromFrame = tag.fromFrame.frameNumber,
  toFrame = tag.toFrame.frameNumber,
  aniDir = tostring(tag.aniDir),
  savedTo = "${luaPath(savePath)}"
} }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to create tag");
    return this.ok(result.data ?? result);
  }

  private async handleRemoveTag(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const tagName = this.requireParam(args, "tagName");
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local found = nil
for i, tag in ipairs(spr.tags) do
  if tag.name == "${luaEscape(tagName)}" then found = tag; break end
end
if not found then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Tag not found: ${luaEscape(tagName)}" }))
  return
end
spr:deleteTag(found)
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { removed = "${luaEscape(tagName)}", savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to remove tag");
    return this.ok(result.data ?? result);
  }

  private async handleListTags(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local tags = {}
for i, tag in ipairs(spr.tags) do
  table.insert(tags, {
    name = tag.name,
    fromFrame = tag.fromFrame.frameNumber,
    toFrame = tag.toFrame.frameNumber,
    aniDir = tostring(tag.aniDir),
    repeats = tag.repeats
  })
end
io.write("__RESULT__" .. json.encode({ success = true, data = { totalTags = #spr.tags, tags = tags } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to list tags");
    return this.ok(result.data ?? result);
  }

  // -- Drawing & Pixel Operations --

  private getCelScript(layerName: string | undefined, frameNumber: number): string {
    if (!layerName) {
      return `
local layer = spr.layers[1]
local frameNum = ${frameNumber}
`;
    }
    return `
${this.findLayerLua("layer", layerName)}
local frameNum = ${frameNumber}
`;
  }

  private getOrCreateCelScript(): string {
    return `
local cel = layer:cel(frameNum)
if not cel then
  cel = spr:newCel(layer, frameNum)
end
local img = cel.image:clone()
local pos = cel.position
`;
  }

  private saveCelScript(savePath: string): string {
    return `
cel.image = img
spr:saveCopyAs("${luaPath(savePath)}")
`;
  }

  private async handleDrawPixels(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.optParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const pixels = args.pixels as Array<{ x: number; y: number; color: unknown }>;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    if (!pixels || !Array.isArray(pixels) || pixels.length === 0) {
      return this.error("pixels array is required and must not be empty");
    }

    const pixelLines = pixels
      .map((p) => `  img:drawPixel(${p.x} - pos.x, ${p.y} - pos.y, ${this.luaColor(p.color)})`)
      .join("\n");

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.getCelScript(layerName, frameNumber)}
${this.getOrCreateCelScript()}
app.transaction(function()
${pixelLines}
end)
${this.saveCelScript(savePath)}
io.write("__RESULT__" .. json.encode({ success = true, data = { pixelsDrawn = ${pixels.length}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to draw pixels");
    return this.ok(result.data ?? result);
  }

  private async handleDrawRect(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.optParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const x = this.numParam(args, "x")!;
    const y = this.numParam(args, "y")!;
    const width = this.numParam(args, "width")!;
    const height = this.numParam(args, "height")!;
    const color = args.color;
    const filled = this.boolParam(args, "filled", true);
    const thickness = this.numParam(args, "thickness", 1)!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const luaCol = this.luaColor(color);

    // Use app.useTool() for thick strokes, manual pixels for thickness=1
    let drawScript: string;
    if (thickness > 1 && !filled) {
      drawScript = `
${this.useToolSetup(layerName, frameNumber)}
app.fgColor = ${luaCol}
app.useTool{
  tool = "rectangle",
  color = ${luaCol},
  brush = Brush{ size = ${thickness} },
  points = { Point(${x}, ${y}), Point(${x + width - 1}, ${y + height - 1}) }
}
spr:saveCopyAs("${luaPath(savePath)}")
`;
    } else {
      drawScript = `
${this.getCelScript(layerName, frameNumber)}
${this.getOrCreateCelScript()}
local c = ${luaCol}
app.transaction(function()
${filled
    ? `  for dy = 0, ${height - 1} do
    for dx = 0, ${width - 1} do
      img:drawPixel(${x} + dx - pos.x, ${y} + dy - pos.y, c)
    end
  end`
    : `  for dx = 0, ${width - 1} do
    img:drawPixel(${x} + dx - pos.x, ${y} - pos.y, c)
    img:drawPixel(${x} + dx - pos.x, ${y} + ${height - 1} - pos.y, c)
  end
  for dy = 0, ${height - 1} do
    img:drawPixel(${x} - pos.x, ${y} + dy - pos.y, c)
    img:drawPixel(${x} + ${width - 1} - pos.x, ${y} + dy - pos.y, c)
  end`}
end)
${this.saveCelScript(savePath)}
`;
    }

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${drawScript}
io.write("__RESULT__" .. json.encode({ success = true, data = { rect = {x=${x}, y=${y}, width=${width}, height=${height}}, filled = ${filled}, thickness = ${thickness}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to draw rectangle");
    return this.ok(result.data ?? result);
  }

  private async handleDrawCircle(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.optParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const cx = this.numParam(args, "centerX")!;
    const cy = this.numParam(args, "centerY")!;
    const radius = this.numParam(args, "radius")!;
    const color = args.color;
    const filled = this.boolParam(args, "filled", true);
    const thickness = this.numParam(args, "thickness", 1)!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const luaCol = this.luaColor(color);

    // Use app.useTool() for thick strokes
    let drawScript: string;
    if (thickness > 1 && !filled) {
      const x1 = cx - radius;
      const y1 = cy - radius;
      const x2 = cx + radius;
      const y2 = cy + radius;
      drawScript = `
${this.useToolSetup(layerName, frameNumber)}
app.fgColor = ${luaCol}
app.useTool{
  tool = "ellipse",
  color = ${luaCol},
  brush = Brush{ size = ${thickness} },
  points = { Point(${x1}, ${y1}), Point(${x2}, ${y2}) }
}
spr:saveCopyAs("${luaPath(savePath)}")
`;
    } else {
      drawScript = `
${this.getCelScript(layerName, frameNumber)}
${this.getOrCreateCelScript()}
local c = ${luaCol}
local cx, cy, r = ${cx}, ${cy}, ${radius}
local filled = ${filled}

local function drawPixelSafe(ix, iy)
  local lx = ix - pos.x
  local ly = iy - pos.y
  if lx >= 0 and lx < img.width and ly >= 0 and ly < img.height then
    img:drawPixel(lx, ly, c)
  end
end

app.transaction(function()
  if filled then
    for dy = -r, r do
      for dx = -r, r do
        if dx*dx + dy*dy <= r*r then
          drawPixelSafe(cx + dx, cy + dy)
        end
      end
    end
  else
    local x = r
    local y = 0
    local d = 1 - r
    while x >= y do
      drawPixelSafe(cx + x, cy + y)
      drawPixelSafe(cx - x, cy + y)
      drawPixelSafe(cx + x, cy - y)
      drawPixelSafe(cx - x, cy - y)
      drawPixelSafe(cx + y, cy + x)
      drawPixelSafe(cx - y, cy + x)
      drawPixelSafe(cx + y, cy - x)
      drawPixelSafe(cx - y, cy - x)
      y = y + 1
      if d < 0 then
        d = d + 2 * y + 1
      else
        x = x - 1
        d = d + 2 * (y - x) + 1
      end
    end
  end
end)
${this.saveCelScript(savePath)}
`;
    }

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${drawScript}
io.write("__RESULT__" .. json.encode({ success = true, data = { center = {x=${cx}, y=${cy}}, radius = ${radius}, filled = ${filled}, thickness = ${thickness}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to draw circle");
    return this.ok(result.data ?? result);
  }

  private async handleDrawLine(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.optParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const x1 = this.numParam(args, "x1")!;
    const y1 = this.numParam(args, "y1")!;
    const x2 = this.numParam(args, "x2")!;
    const y2 = this.numParam(args, "y2")!;
    const color = args.color;
    const thickness = this.numParam(args, "thickness", 1)!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const luaCol = this.luaColor(color);

    // Use app.useTool() for thick lines, Bresenham for thickness=1
    let drawScript: string;
    if (thickness > 1) {
      drawScript = `
${this.useToolSetup(layerName, frameNumber)}
app.fgColor = ${luaCol}
app.useTool{
  tool = "line",
  color = ${luaCol},
  brush = Brush{ size = ${thickness} },
  points = { Point(${x1}, ${y1}), Point(${x2}, ${y2}) }
}
spr:saveCopyAs("${luaPath(savePath)}")
`;
    } else {
      drawScript = `
${this.getCelScript(layerName, frameNumber)}
${this.getOrCreateCelScript()}
local c = ${luaCol}

app.transaction(function()
  local x0, y0, x1, y1= ${x1}, ${y1}, ${x2}, ${y2}
  local dx = math.abs(x1 - x0)
  local dy = -math.abs(y1 - y0)
  local sx = x0 < x1 and 1 or -1
  local sy = y0 < y1 and 1 or -1
  local err = dx + dy
  while true do
    local lx = x0 - pos.x
    local ly = y0 - pos.y
    if lx >= 0 and lx < img.width and ly >= 0 and ly < img.height then
      img:drawPixel(lx, ly, c)
    end
    if x0 == x1 and y0 == y1 then break end
    local e2 = 2 * err
    if e2 >= dy then err = err + dy; x0 = x0 + sx end
    if e2 <= dx then err = err + dx; y0 = y0 + sy end
  end
end)
${this.saveCelScript(savePath)}
`;
    }

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${drawScript}
io.write("__RESULT__" .. json.encode({ success = true, data = { from = {x=${x1}, y=${y1}}, to = {x=${x2}, y=${y2}}, thickness = ${thickness}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to draw line");
    return this.ok(result.data ?? result);
  }

  private async handleDrawEllipse(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.optParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const x = this.numParam(args, "x")!;
    const y = this.numParam(args, "y")!;
    const width = this.numParam(args, "width")!;
    const height = this.numParam(args, "height")!;
    const color = args.color;
    const filled = this.boolParam(args, "filled", true);
    const thickness = this.numParam(args, "thickness", 1)!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const luaCol = this.luaColor(color);
    const toolName = filled ? "filled_ellipse" : "ellipse";

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.useToolSetup(layerName, frameNumber)}
app.fgColor = ${luaCol}
app.useTool{
  tool = "${toolName}",
  color = ${luaCol},
  brush = Brush{ size = ${thickness} },
  points = { Point(${x}, ${y}), Point(${x + width - 1}, ${y + height - 1}) }
}
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { bounds = {x=${x}, y=${y}, width=${width}, height=${height}}, filled = ${filled}, thickness = ${thickness}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to draw ellipse");
    return this.ok(result.data ?? result);
  }

  private async handleFillArea(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.optParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const x = this.numParam(args, "x")!;
    const y = this.numParam(args, "y")!;
    const color = args.color;
    const tolerance = this.numParam(args, "tolerance", 0)!;
    const contiguous = this.boolParam(args, "contiguous", true);
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const luaCol = this.luaColor(color);

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.useToolSetup(layerName, frameNumber)}
app.fgColor = ${luaCol}
app.preferences.tool("paint_bucket").tolerance = ${tolerance}
app.preferences.tool("paint_bucket").contiguous = ${contiguous}
app.useTool{
  tool = "paint_bucket",
  color = ${luaCol},
  point = Point(${x}, ${y})
}
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { point = {x=${x}, y=${y}}, tolerance = ${tolerance}, contiguous = ${contiguous}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to fill area");
    return this.ok(result.data ?? result);
  }

  private async handleReplaceColor(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const fromColor = args.from_color ?? args.fromColor;
    const toColor = args.to_color ?? args.toColor;
    const layerName = this.optParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber");
    const tolerance = this.numParam(args, "tolerance", 0)!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    if (!fromColor || !toColor) {
      return this.error("Both fromColor and toColor are required");
    }

    const luaFrom = this.luaColor(fromColor);
    const luaTo = this.luaColor(toColor);

    const layerFilter = layerName
      ? `${this.findLayerLua("targetLayer", layerName)}
local layersToProcess = { targetLayer }`
      : `local layersToProcess = spr.layers`;

    const frameFilter = frameNumber !== undefined
      ? `local framesToProcess = { spr.frames[${frameNumber}] }`
      : `local framesToProcess = spr.frames`;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${layerFilter}
${frameFilter}

local fromCol = ${luaFrom}
local toCol = ${luaTo}
local tolerance = ${tolerance}
local replaced = 0

local function colorMatch(a, b, tol)
  if tol == 0 then
    return a.red == b.red and a.green == b.green and a.blue == b.blue and a.alpha == b.alpha
  end
  return math.abs(a.red - b.red) <= tol and
         math.abs(a.green - b.green) <= tol and
         math.abs(a.blue - b.blue) <= tol and
         math.abs(a.alpha - b.alpha) <= tol
end

app.transaction(function()
  for _, layer in ipairs(layersToProcess) do
    if not layer.isGroup then
      for _, frame in ipairs(framesToProcess) do
        local cel = layer:cel(frame.frameNumber)
        if cel then
          local img = cel.image:clone()
          for y = 0, img.height - 1 do
            for x = 0, img.width - 1 do
              local px = img:getPixel(x, y)
              local pxColor = Color(px)
              if colorMatch(pxColor, fromCol, tolerance) then
                img:drawPixel(x, y, toCol)
                replaced = replaced + 1
              end
            end
          end
          cel.image = img
        end
      end
    end
  end
end)
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { pixelsReplaced = replaced, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to replace color");
    return this.ok(result.data ?? result);
  }

  private async handleFlipSprite(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const direction = this.requireParam(args, "direction");
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const orientation = direction === "horizontal" ? "FlipHorizontal" : "FlipVertical";

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
app.activeSprite = spr
app.command.Flip{ target="canvas", orientation="${orientation}" }
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { direction = "${luaEscape(direction)}", savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to flip sprite");
    return this.ok(result.data ?? result);
  }

  private async handleRotateSprite(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const angle = this.numParam(args, "angle")!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    if (![90, 180, 270].includes(angle)) {
      return this.error("Angle must be 90, 180, or 270 degrees");
    }

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
app.activeSprite = spr
app.command.RotateCanvas{ angle=${angle} }
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { angle = ${angle}, width = spr.width, height = spr.height, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to rotate sprite");
    return this.ok(result.data ?? result);
  }

  private async handleFlattenLayers(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
spr:flatten()
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { layerCount = #spr.layers, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to flatten layers");
    return this.ok(result.data ?? result);
  }

  private async handleMergeDown(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.requireParam(args, "layerName");
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.findLayerLua("target", layerName)}
app.activeSprite = spr
app.activeLayer = target
app.command.MergeDownLayer()
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { merged = "${luaEscape(layerName)}", layerCount = #spr.layers, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to merge layer down");
    return this.ok(result.data ?? result);
  }

  private async handleOutline(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.optParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const color = args.color;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const luaCol = this.luaColor(color);

    // Manual outline: find non-transparent pixels with transparent neighbors
    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.getCelScript(layerName, frameNumber)}
${this.getOrCreateCelScript()}
local outlineColor = ${luaCol}
local outlinePixels = {}

-- Find all edge pixels (non-transparent with at least one transparent neighbor)
for py = 0, img.height - 1 do
  for px = 0, img.width - 1 do
    local pixel = img:getPixel(px, py)
    local a = Color(pixel).alpha
    if a == 0 then
      -- Check if any neighbor is non-transparent
      local neighbors = {
        {px-1, py}, {px+1, py}, {px, py-1}, {px, py+1}
      }
      for _, n in ipairs(neighbors) do
        if n[1] >= 0 and n[1] < img.width and n[2] >= 0 and n[2] < img.height then
          local np = img:getPixel(n[1], n[2])
          if Color(np).alpha > 0 then
            table.insert(outlinePixels, {px, py})
            break
          end
        end
      end
    end
  end
end

app.transaction(function()
  for _, p in ipairs(outlinePixels) do
    img:drawPixel(p[1], p[2], outlineColor)
  end
end)
${this.saveCelScript(savePath)}
io.write("__RESULT__" .. json.encode({ success = true, data = { outlinePixels = #outlinePixels, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to add outline");
    return this.ok(result.data ?? result);
  }

  // -- Palette --

  private async handleGetPalette(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local pal = spr.palettes[1]
local colors = {}
for i = 0, #pal - 1 do
  local c = pal:getColor(i)
  table.insert(colors, { index = i, r = c.red, g = c.green, b = c.blue, a = c.alpha })
end
io.write("__RESULT__" .. json.encode({ success = true, data = { paletteSize = #pal, colors = colors } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to get palette");
    return this.ok(result.data ?? result);
  }

  private async handleSetPaletteColors(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const colors = args.colors as Array<{ index: number; r: number; g: number; b: number; a?: number }>;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    if (!colors || !Array.isArray(colors)) {
      return this.error("colors array is required");
    }

    const setLines = colors
      .map((c) => `  pal:setColor(${c.index}, Color{ r=${c.r}, g=${c.g}, b=${c.b}, a=${c.a ?? 255} })`)
      .join("\n");

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local pal = spr.palettes[1]
app.transaction(function()
${setLines}
end)
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { colorsSet = ${colors.length}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to set palette colors");
    return this.ok(result.data ?? result);
  }

  private async handleLoadPalette(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const palettePath = this.requireParam(args, "palettePath");
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
spr:loadPalette("${luaPath(palettePath)}")
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { paletteLoaded = "${luaPath(palettePath)}", savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to load palette");
    return this.ok(result.data ?? result);
  }

  private async handleResizePalette(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const newSize = this.numParam(args, "newSize")!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local pal = spr.palettes[1]
pal:resize(${newSize})
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { newSize = ${newSize}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to resize palette");
    return this.ok(result.data ?? result);
  }

  // -- Cel Operations --

  private async handleMoveCel(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.requireParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const x = this.numParam(args, "x")!;
    const y = this.numParam(args, "y")!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.findLayerLua("target", layerName)}
local cel = target:cel(${frameNumber})
if not cel then
  io.write("__RESULT__" .. json.encode({ success = false, error = "No cel at frame ${frameNumber} on layer ${luaEscape(layerName)}" }))
  return
end
cel.position = Point(${x}, ${y})
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { position = {x=${x}, y=${y}}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to move cel");
    return this.ok(result.data ?? result);
  }

  private async handleSetCelOpacity(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.requireParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const opacity = this.numParam(args, "opacity")!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.findLayerLua("target", layerName)}
local cel = target:cel(${frameNumber})
if not cel then
  io.write("__RESULT__" .. json.encode({ success = false, error = "No cel at frame ${frameNumber} on layer ${luaEscape(layerName)}" }))
  return
end
cel.opacity = ${opacity}
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { opacity = ${opacity}, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to set cel opacity");
    return this.ok(result.data ?? result);
  }

  private async handleClearCel(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const layerName = this.requireParam(args, "layerName");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
${this.findLayerLua("target", layerName)}
local cel = target:cel(${frameNumber})
if cel then
  spr:deleteCel(cel)
end
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { cleared = true, savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to clear cel");
    return this.ok(result.data ?? result);
  }

  // -- Export --

  private async handleExportSpriteSheet(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const outputImage = this.requireParam(args, "outputImage");
    const dataFile = this.optParam(args, "dataFile");
    const sheetType = this.optParam(args, "sheetType") ?? "rows";
    const columns = this.numParam(args, "columns");
    const rows = this.numParam(args, "rows");
    const borderPadding = this.numParam(args, "borderPadding");
    const shapePadding = this.numParam(args, "shapePadding");
    const innerPadding = this.numParam(args, "innerPadding");
    const trim = this.boolParam(args, "trim", false);
    const mergeDuplicates = this.boolParam(args, "mergeDuplicates", false);
    const layer = this.optParam(args, "layer");
    const tag = this.optParam(args, "tag");
    const splitLayers = this.boolParam(args, "splitLayers", false);

    const cliArgs = ["-b", filePath];
    if (layer) cliArgs.push("--layer", layer);
    if (tag) cliArgs.push("--tag", tag);
    if (splitLayers) cliArgs.push("--split-layers");
    if (trim) cliArgs.push("--trim");
    if (mergeDuplicates) cliArgs.push("--merge-duplicates");
    cliArgs.push("--sheet", outputImage);
    cliArgs.push("--sheet-type", sheetType);
    if (columns !== undefined) cliArgs.push("--sheet-columns", String(columns));
    if (rows !== undefined) cliArgs.push("--sheet-rows", String(rows));
    if (borderPadding !== undefined) cliArgs.push("--border-padding", String(borderPadding));
    if (shapePadding !== undefined) cliArgs.push("--shape-padding", String(shapePadding));
    if (innerPadding !== undefined) cliArgs.push("--inner-padding", String(innerPadding));
    if (dataFile) {
      cliArgs.push("--data", dataFile);
      cliArgs.push("--format", "json-array");
    }

    try {
      const { stdout, stderr } = await this.runCliCommand(cliArgs);
      return this.ok({
        outputImage,
        dataFile: dataFile ?? null,
        sheetType,
        stdout: stdout.trim(),
      });
    } catch (err: unknown) {
      return this.error(`Sprite sheet export failed: ${(err as Error).message}`);
    }
  }

  private async handleExportFrame(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const frameNumber = this.numParam(args, "frameNumber", 1)!;
    const outputPath = this.requireParam(args, "outputPath");
    const layerName = this.optParam(args, "layerName");

    const cliArgs = ["-b", filePath];
    if (layerName) cliArgs.push("--layer", layerName);
    cliArgs.push("--frame-range", `${frameNumber - 1},${frameNumber - 1}`);
    cliArgs.push("--save-as", outputPath);

    try {
      await this.runCliCommand(cliArgs);
      return this.ok({ exportedFrame: frameNumber, outputPath });
    } catch (err: unknown) {
      return this.error(`Frame export failed: ${(err as Error).message}`);
    }
  }

  private async handleExportLayers(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const outputPattern = this.requireParam(args, "outputPattern");
    const frameNumber = this.numParam(args, "frameNumber");

    const cliArgs = ["-b", filePath, "--split-layers"];
    if (frameNumber !== undefined) {
      cliArgs.push("--frame-range", `${frameNumber - 1},${frameNumber - 1}`);
    }
    cliArgs.push("--save-as", outputPattern);

    try {
      await this.runCliCommand(cliArgs);
      return this.ok({ outputPattern });
    } catch (err: unknown) {
      return this.error(`Layer export failed: ${(err as Error).message}`);
    }
  }

  private async handleExportReviewPack(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const resolved = await this.resolveSpriteFile(args);
      const filePath = resolved.filePath;
      const summary = await this.getSpriteReviewSummary(filePath);
      const spritePath = parse(filePath);
      const outputDir = this.optParam(args, "outputDir") ?? dirname(filePath);
      const baseName = this.optParam(args, "baseName") ?? `${spritePath.name}-review`;
      const scale = this.numParam(args, "scale", 8)!;
      const includeGif = this.boolParam(args, "includeGif", true);
      const includeGrid = this.boolParam(args, "includeGrid", true);
      const layer = this.optParam(args, "layer");
      const frameCount = Number(summary.frameCount ?? 1);
      const tagCount = Number(summary.tagCount ?? 0);
      const columns =
        this.numParam(args, "columns") ??
        (tagCount > 0 && frameCount % tagCount === 0
          ? tagCount
          : Math.max(1, Math.ceil(Math.sqrt(frameCount))));
      if (!Number.isInteger(scale) || scale < 1) {
        throw new Error("scale must be a positive integer");
      }
      if (!Number.isInteger(columns) || columns < 1) {
        throw new Error("columns must be a positive integer");
      }
      const rows = Math.max(1, Math.ceil(frameCount / columns));

      await mkdir(outputDir, { recursive: true });

      const sheet1x = join(outputDir, `${baseName}-1x.png`);
      const dataFile = join(outputDir, `${baseName}.json`);
      const sheetScaled = join(outputDir, `${baseName}-${scale}x.png`);
      const sheetGrid = join(outputDir, `${baseName}-${scale}x-grid.png`);
      const gifPath = join(outputDir, `${baseName}-${scale}x.gif`);
      const reviewIndexPath = join(outputDir, `${baseName}-review-pack.json`);
      const comparisonPath = join(outputDir, `${baseName}-comparison.json`);

      const baseSheetArgs = ["-b", filePath];
      if (layer) baseSheetArgs.push("--layer", layer);
      baseSheetArgs.push(
        "--sheet",
        sheet1x,
        "--data",
        dataFile,
        "--format",
        "json-array",
        "--sheet-type",
        "rows",
        "--sheet-columns",
        String(columns),
      );
      await this.runCliCommand(baseSheetArgs);

      const scaledSheetArgs = ["-b", filePath, "--scale", String(scale)];
      if (layer) scaledSheetArgs.push("--layer", layer);
      scaledSheetArgs.push(
        "--sheet",
        sheetScaled,
        "--sheet-type",
        "rows",
        "--sheet-columns",
        String(columns),
      );
      await this.runCliCommand(scaledSheetArgs);

      let gridOutput: string | null = null;
      if (includeGrid) {
        const cellWidth = Number(summary.width ?? 0) * scale;
        const cellHeight = Number(summary.height ?? 0) * scale;
        const gridScript = `
local spr = app.open("${luaPath(sheetScaled)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open upscaled sheet" }))
  return
end
local layer = spr.layers[1]
local cel = layer and layer:cel(1)
if not cel then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Upscaled sheet has no drawable cel" }))
  return
end
local img = cel.image
local pos = cel.position
local color = Color{ r=255, g=0, b=0, a=255 }
local cellWidth = ${cellWidth}
local cellHeight = ${cellHeight}
app.transaction(function()
  for x = 0, spr.width - 1, cellWidth do
    for y = 0, spr.height - 1 do
      img:drawPixel(x - pos.x, y - pos.y, color)
    end
  end
  for y = 0, spr.height - 1, cellHeight do
    for x = 0, spr.width - 1 do
      img:drawPixel(x - pos.x, y - pos.y, color)
    end
  end
end)
spr:saveCopyAs("${luaPath(sheetGrid)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { output = "${luaPath(sheetGrid)}" } }))
`;
        const gridResult = await this.runLuaScript(gridScript);
        if (!gridResult.success) {
          throw new Error(gridResult.error ?? "Failed to write review grid");
        }
        gridOutput = sheetGrid;
      }

      let gifOutput: string | null = null;
      if (includeGif) {
        const gifArgs = ["-b", filePath, "--scale", String(scale)];
        if (layer) gifArgs.push("--layer", layer);
        gifArgs.push("--save-as", gifPath);
        await this.runCliCommand(gifArgs);
        gifOutput = gifPath;
      }

      let comparison: Record<string, unknown> | null = null;
      const baseLayerName = this.optParam(args, "baseLayerName");
      const finalLayerName = this.optParam(args, "finalLayerName");
      if (baseLayerName && finalLayerName) {
        comparison = await this.compareTemplateLayersData({
          filePath,
          baseLayerName,
          finalLayerName,
          allowedExpansionPx: this.numParam(args, "allowedExpansionPx", 0),
          centerTolerancePx: this.numParam(args, "centerTolerancePx", 1),
          contactTolerancePx: this.numParam(args, "contactTolerancePx", 0),
        });
        await writeFile(comparisonPath, JSON.stringify(comparison, null, 2), "utf-8");
      }

      const reviewPack = {
        source: resolved,
        generatedAt: new Date().toISOString(),
        sprite: summary,
        layout: {
          scale,
          columns,
          rows,
          layer: layer ?? null,
        },
        outputs: {
          sheet1x,
          sheetScaled,
          sheetGrid: gridOutput,
          gif: gifOutput,
          dataFile,
          comparison: comparison ? comparisonPath : null,
          reviewIndex: reviewIndexPath,
        },
        comparisonSummary: comparison
          ? (comparison.summary as Record<string, unknown> | undefined)
          : null,
      };

      await writeFile(reviewIndexPath, JSON.stringify(reviewPack, null, 2), "utf-8");
      return this.ok(reviewPack);
    } catch (err: unknown) {
      return this.error(`Review pack export failed: ${(err as Error).message}`);
    }
  }

  private async handleCompareTemplateLayers(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return this.ok(await this.compareTemplateLayersData(args));
    } catch (err: unknown) {
      return this.error(`Template comparison failed: ${(err as Error).message}`);
    }
  }

  // -- Slices --

  private async handleCreateSlice(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const sliceName = this.requireParam(args, "sliceName");
    const x = this.numParam(args, "x")!;
    const y = this.numParam(args, "y")!;
    const width = this.numParam(args, "width")!;
    const height = this.numParam(args, "height")!;
    const pivotX = this.numParam(args, "pivotX");
    const pivotY = this.numParam(args, "pivotY");
    const savePath = this.optParam(args, "savePath") ?? filePath;

    let pivotLine = "";
    if (pivotX !== undefined && pivotY !== undefined) {
      pivotLine = `slice.pivot = Point(${pivotX}, ${pivotY})`;
    }

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local slice = spr:newSlice(Rectangle(${x}, ${y}, ${width}, ${height}))
slice.name = "${luaEscape(sliceName)}"
${pivotLine}
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = {
  name = slice.name,
  bounds = { x = ${x}, y = ${y}, width = ${width}, height = ${height} },
  savedTo = "${luaPath(savePath)}"
} }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to create slice");
    return this.ok(result.data ?? result);
  }

  private async handleRemoveSlice(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.requireParam(args, "filePath");
    const sliceName = this.requireParam(args, "sliceName");
    const savePath = this.optParam(args, "savePath") ?? filePath;

    const script = `
local spr = app.open("${luaPath(filePath)}")
if not spr then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Failed to open sprite" }))
  return
end
local found = nil
for i, slice in ipairs(spr.slices) do
  if slice.name == "${luaEscape(sliceName)}" then found = slice; break end
end
if not found then
  io.write("__RESULT__" .. json.encode({ success = false, error = "Slice not found: ${luaEscape(sliceName)}" }))
  return
end
spr:deleteSlice(found)
spr:saveCopyAs("${luaPath(savePath)}")
io.write("__RESULT__" .. json.encode({ success = true, data = { removed = "${luaEscape(sliceName)}", savedTo = "${luaPath(savePath)}" } }))
`;
    const result = await this.runLuaScript(script);
    if (!result.success) return this.error(result.error ?? "Failed to remove slice");
    return this.ok(result.data ?? result);
  }

  // -- Utility --

  private async handleGetBridgeStatus(_args: Record<string, unknown>): Promise<ToolResult> {
    const bridge = await this.readBridgeState();
    const resolved = this.activeSpriteFileFromState(bridge.connected ? bridge.state : null);

    return this.ok({
      bridgeDir: this.bridgeDir(),
      statePath: bridge.statePath,
      snapshotPath: this.bridgeSnapshotPath(),
      connected: bridge.connected,
      stateAvailable: bridge.state !== null,
      connectionReason: bridge.connectionReason,
      modifiedAt: bridge.modifiedAt,
      activeSpriteFile: resolved.filePath,
      activeSpriteSource: resolved.source,
      state: bridge.state,
      error: bridge.error,
    });
  }

  private async handleGetActiveSpriteContext(_args: Record<string, unknown>): Promise<ToolResult> {
    const bridge = await this.readBridgeState();
    if (!bridge.connected) {
      return this.error(
        `Aseprite editor bridge is unavailable (${bridge.connectionReason}) at ${bridge.statePath}`,
        [
          "Install and enable the Aseprite Codex Bridge extension",
          "Use Sprite > Codex MCP > Refresh Context in Aseprite",
          "Set ASEPRITE_MCP_BRIDGE_DIR to the same folder for Aseprite and this MCP server",
        ],
      );
    }

    return this.ok({
      bridgeDir: this.bridgeDir(),
      statePath: bridge.statePath,
      modifiedAt: bridge.modifiedAt,
      state: bridge.state,
    });
  }

  private async handleGetActiveSpriteInfo(_args: Record<string, unknown>): Promise<ToolResult> {
    const bridge = await this.readBridgeState();
    const resolved = this.activeSpriteFileFromState(bridge.connected ? bridge.state : null);
    if (!resolved.filePath) {
      return this.error(
        "No saved or snapshotted active sprite is available from the Aseprite extension bridge",
        [
          "Save the active sprite in Aseprite, or",
          "Use Sprite > Codex MCP > Save Active Snapshot in Aseprite",
        ],
      );
    }

    const result = await this.handleGetSpriteInfo({ filePath: resolved.filePath });
    if (result.isError) return result;

    return this.ok({
      source: resolved.source,
      filePath: resolved.filePath,
      bridgeGeneratedAt: bridge.state?.generatedAt ?? null,
      spriteInfo: JSON.parse(result.content[0].text),
    });
  }

  private async handleSaveActiveSpriteCopy(args: Record<string, unknown>): Promise<ToolResult> {
    const bridge = await this.readBridgeState();
    const resolved = this.activeSpriteFileFromState(bridge.connected ? bridge.state : null);
    if (!resolved.filePath) {
      return this.error(
        "No saved or snapshotted active sprite is available from the Aseprite extension bridge",
        ["Use Sprite > Codex MCP > Save Active Snapshot in Aseprite"],
      );
    }

    const savePath = this.optParam(args, "savePath") ?? join(this.bridgeDir(), "active-sprite-copy.aseprite");
    const result = await this.handleSaveSprite({
      filePath: resolved.filePath,
      savePath,
    });
    if (result.isError) return result;

    return this.ok({
      source: resolved.source,
      sourcePath: resolved.filePath,
      savedTo: savePath,
    });
  }

  private async handleRunScriptOnActiveSprite(args: Record<string, unknown>): Promise<ToolResult> {
    const bridge = await this.readBridgeState();
    const resolved = this.activeSpriteFileFromState(bridge.connected ? bridge.state : null);
    if (!resolved.filePath) {
      return this.error(
        "No saved or snapshotted active sprite is available from the Aseprite extension bridge",
        ["Use Sprite > Codex MCP > Save Active Snapshot in Aseprite"],
      );
    }

    const script = this.requireParam(args, "script");
    const result = await this.runLuaScript(script, resolved.filePath);
    return this.ok({
      source: resolved.source,
      filePath: resolved.filePath,
      result: result.data ?? result,
    });
  }

  private async handleRunScript(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.optParam(args, "filePath");
    const script = this.requireParam(args, "script");

    const result = await this.runLuaScript(script, filePath);
    return this.ok(result.data ?? result);
  }

  private async handleGetAsepriteVersion(_args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const { stdout } = await this.runCliCommand(["--version"]);
      return this.ok({ version: stdout.trim() });
    } catch (err: unknown) {
      return this.error(
        `Failed to get Aseprite version: ${(err as Error).message}`,
        ["Ensure Aseprite is installed and ASEPRITE_PATH is set correctly"],
      );
    }
  }

  // ---- Handler dispatch ---------------------------------------------------

  private setupHandlers() {
    // Map tool names to handler methods
    this.toolHandlers.set("create_sprite", (a) => this.handleCreateSprite(a));
    this.toolHandlers.set("open_sprite", (a) => this.handleOpenSprite(a));
    this.toolHandlers.set("save_sprite", (a) => this.handleSaveSprite(a));
    this.toolHandlers.set("get_sprite_info", (a) => this.handleGetSpriteInfo(a));
    this.toolHandlers.set("resize_sprite", (a) => this.handleResizeSprite(a));
    this.toolHandlers.set("crop_sprite", (a) => this.handleCropSprite(a));
    this.toolHandlers.set("add_layer", (a) => this.handleAddLayer(a));
    this.toolHandlers.set("remove_layer", (a) => this.handleRemoveLayer(a));
    this.toolHandlers.set("list_layers", (a) => this.handleListLayers(a));
    this.toolHandlers.set("set_layer_properties", (a) => this.handleSetLayerProperties(a));
    this.toolHandlers.set("add_frame", (a) => this.handleAddFrame(a));
    this.toolHandlers.set("remove_frame", (a) => this.handleRemoveFrame(a));
    this.toolHandlers.set("set_frame_duration", (a) => this.handleSetFrameDuration(a));
    this.toolHandlers.set("list_frames", (a) => this.handleListFrames(a));
    this.toolHandlers.set("create_tag", (a) => this.handleCreateTag(a));
    this.toolHandlers.set("remove_tag", (a) => this.handleRemoveTag(a));
    this.toolHandlers.set("list_tags", (a) => this.handleListTags(a));
    this.toolHandlers.set("draw_pixels", (a) => this.handleDrawPixels(a));
    this.toolHandlers.set("draw_rect", (a) => this.handleDrawRect(a));
    this.toolHandlers.set("draw_circle", (a) => this.handleDrawCircle(a));
    this.toolHandlers.set("draw_line", (a) => this.handleDrawLine(a));
    this.toolHandlers.set("draw_ellipse", (a) => this.handleDrawEllipse(a));
    this.toolHandlers.set("fill_area", (a) => this.handleFillArea(a));
    this.toolHandlers.set("replace_color", (a) => this.handleReplaceColor(a));
    this.toolHandlers.set("flip_sprite", (a) => this.handleFlipSprite(a));
    this.toolHandlers.set("rotate_sprite", (a) => this.handleRotateSprite(a));
    this.toolHandlers.set("flatten_layers", (a) => this.handleFlattenLayers(a));
    this.toolHandlers.set("merge_down", (a) => this.handleMergeDown(a));
    this.toolHandlers.set("outline", (a) => this.handleOutline(a));
    this.toolHandlers.set("get_palette", (a) => this.handleGetPalette(a));
    this.toolHandlers.set("set_palette_colors", (a) => this.handleSetPaletteColors(a));
    this.toolHandlers.set("load_palette", (a) => this.handleLoadPalette(a));
    this.toolHandlers.set("resize_palette", (a) => this.handleResizePalette(a));
    this.toolHandlers.set("move_cel", (a) => this.handleMoveCel(a));
    this.toolHandlers.set("set_cel_opacity", (a) => this.handleSetCelOpacity(a));
    this.toolHandlers.set("clear_cel", (a) => this.handleClearCel(a));
    this.toolHandlers.set("export_sprite_sheet", (a) => this.handleExportSpriteSheet(a));
    this.toolHandlers.set("export_frame", (a) => this.handleExportFrame(a));
    this.toolHandlers.set("export_layers", (a) => this.handleExportLayers(a));
    this.toolHandlers.set("export_review_pack", (a) => this.handleExportReviewPack(a));
    this.toolHandlers.set("compare_template_layers", (a) => this.handleCompareTemplateLayers(a));
    this.toolHandlers.set("create_slice", (a) => this.handleCreateSlice(a));
    this.toolHandlers.set("remove_slice", (a) => this.handleRemoveSlice(a));
    this.toolHandlers.set("get_bridge_status", (a) => this.handleGetBridgeStatus(a));
    this.toolHandlers.set("get_active_sprite_context", (a) => this.handleGetActiveSpriteContext(a));
    this.toolHandlers.set("get_active_sprite_info", (a) => this.handleGetActiveSpriteInfo(a));
    this.toolHandlers.set("save_active_sprite_copy", (a) => this.handleSaveActiveSpriteCopy(a));
    this.toolHandlers.set("run_script_on_active_sprite", (a) => this.handleRunScriptOnActiveSprite(a));
    this.toolHandlers.set("run_script", (a) => this.handleRunScript(a));
    this.toolHandlers.set("get_aseprite_version", (a) => this.handleGetAsepriteVersion(a));

    // ListTools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.toolDefinitions(),
    }));

    // CallTool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const handler = this.toolHandlers.get(name);
      if (!handler) {
        return this.error(`Unknown tool: ${name}`);
      }
      try {
        return await handler((args as Record<string, unknown>) ?? {});
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return this.error(`Tool ${name} failed: ${msg}`);
      }
    });
  }

  // ---- Start --------------------------------------------------------------

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("[aseprite-mcp] Server running on stdio");
  }
}

// ---------------------------------------------------------------------------
// Main — only runs when executed directly, not when imported
// ---------------------------------------------------------------------------
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"));

if (isMainModule) {
  const server = new AsepriteMcpServer();
  server.run().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
