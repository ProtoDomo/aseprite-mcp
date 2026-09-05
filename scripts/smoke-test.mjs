import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A deterministic integration fixture, not production artwork. Never edits an existing file.
const outputDir = resolve(process.argv[2] ?? "smoke-output");
await mkdir(outputDir, { recursive: false });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filePath = join(outputDir, "integration-fixture.aseprite");
const client = new Client({ name: "aseprite-integration-smoke", version: "1.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "build/index.js")], env: { ...process.env }, stderr: "pipe" });
const calls = [];
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name}: ${JSON.stringify(r)}`);
  const value = JSON.parse(r.content[0].text);
  calls.push({ name, result: value });
  return value;
}
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  await writeFile(join(outputDir, "tools.json"), JSON.stringify(tools, null, 2));
  await call("get_aseprite_version");
  await call("create_sprite", { width: 16, height: 16, savePath: filePath });
  await call("add_layer", { filePath, layerName: "Ink" });
  await call("resize_palette", { filePath, newSize: 3 });
  await call("set_palette_colors", { filePath, colors: [{ index: 0, r: 0, g: 0, b: 0, a: 0 }, { index: 1, r: 255, g: 0, b: 0 }, { index: 2, r: 0, g: 255, b: 0 }] });
  await call("draw_pixels", { filePath, layerName: "Ink", pixels: [{ x: 3, y: 4, color: "#FF0000" }] });
  await call("add_frame", { filePath, empty: true });
  await call("draw_pixels", { filePath, layerName: "Ink", frameNumber: 2, pixels: [{ x: 4, y: 4, color: "#00FF00" }] });
  await call("set_frame_duration", { filePath, frameNumber: 1, durationMs: 140 });
  await call("set_frame_duration", { filePath, frameNumber: 2, durationMs: 220 });
  await call("create_tag", { filePath, tagName: "smoke", fromFrame: 1, toFrame: 2 });
  for (const name of ["get_sprite_info", "list_layers", "list_frames", "list_tags", "get_palette"]) await call(name, { filePath });
  await call("run_script", { filePath, script: `
local s = app.sprite
assert(s.width == 16 and s.height == 16 and #s.frames == 2)
assert(math.abs(s.frames[1].duration - 0.14) < 0.0001)
assert(math.abs(s.frames[2].duration - 0.22) < 0.0001)
assert(s.tags[1].name == "smoke" and #s.palettes[1] == 3)
local ink
for _, l in ipairs(s.layers) do if l.name == "Ink" then ink = l end end
for i = 1, 2 do
 local c = ink:cel(i)
 local p = c.image:getPixel(i + 2 - c.position.x, 4 - c.position.y)
 assert(app.pixelColor.rgbaA(p) == 255)
 if i == 1 then assert(app.pixelColor.rgbaR(p) == 255) else assert(app.pixelColor.rgbaG(p) == 255) end
end
print('__RESULT__' .. json.encode({pixels=true, timing=true, tags=true, palette=true}))` });
  await call("export_frame", { filePath, frameNumber: 1, outputPath: join(outputDir, "frame.png") });
  await call("export_sprite_sheet", { filePath, outputImage: join(outputDir, "sheet.png"), dataFile: join(outputDir, "sheet.json"), sheetType: "horizontal" });
  const pack = await call("export_review_pack", { filePath, outputDir: join(outputDir, "review"), scale: 8, columns: 2, includeGif: true });
  await call("save_sprite", { filePath, savePath: join(outputDir, "roundtrip.aseprite") });
  await call("open_sprite", { filePath: join(outputDir, "roundtrip.aseprite") });
  for (const file of [filePath, join(outputDir, "frame.png"), join(outputDir, "sheet.png"), join(outputDir, "sheet.json")]) assert.ok((await stat(file)).size > 0);
  const sheet = JSON.parse(await readFile(join(outputDir, "sheet.json"), "utf8"));
  assert.deepEqual(Object.values(sheet.frames).map(f => f.duration), [140, 220]);
  await writeFile(join(outputDir, "result.json"), JSON.stringify({ pass: true, toolCount: tools.length, calls, pack }, null, 2));
  console.log(JSON.stringify({ pass: true, toolCount: tools.length, calls: calls.length, outputDir, filePath, pack }, null, 2));
} finally { await client.close(); }
