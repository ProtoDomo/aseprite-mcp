# API Reference

Full tool reference for aseprite-mcp. See [README](../README.md) for setup and quick-start.

## Color Format

Colors can be specified in three ways:

| Format | Example | Description |
|--------|---------|-------------|
| Hex string | `"#FF0000"` or `"#FF0000FF"` | `#RRGGBB` or `#RRGGBBAA` |
| Palette index | `5` | Index into the sprite's palette |
| RGBA object | `{ "r": 255, "g": 0, "b": 0, "a": 255 }` | Component values 0–255 |

---

## Sprite Management

#### `create_sprite`
Create a new Aseprite sprite file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `width` | number | ✅ | Width in pixels |
| `height` | number | ✅ | Height in pixels |
| `savePath` | string | ✅ | Path to save the new sprite file |
| `colorMode` | string | | `"rgb"` (default), `"grayscale"`, or `"indexed"` |

#### `open_sprite`
Open a sprite file and return its metadata (dimensions, layers, frames, tags, slices, palette size).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Path to sprite file (`.aseprite`, `.ase`, `.png`, etc.) |

#### `save_sprite`
Save or convert a sprite to a different format or path. The format is inferred from the file extension.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Source sprite file |
| `savePath` | string | ✅ | Destination path (`.png`, `.gif`, `.aseprite`, etc.) |

#### `get_sprite_info`
Get detailed sprite metadata: dimensions, color mode, full layer tree, all frames with durations, animation tags, slices, and palette size.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Path to sprite file |

**Returns:** JSON with `width`, `height`, `colorMode`, `frameCount`, `layerCount`, `layers` (recursive tree with visibility/opacity/blend mode), `frames` (with durations), `tags`, `slices`, `paletteSize`.

#### `resize_sprite`
Resize a sprite to new dimensions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Source sprite file |
| `width` | number | ✅ | New width in pixels |
| `height` | number | ✅ | New height in pixels |
| `savePath` | string | | Path to save (defaults to overwrite source) |

#### `crop_sprite`
Crop a sprite to given bounds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Source sprite file |
| `x` | number | ✅ | Left edge |
| `y` | number | ✅ | Top edge |
| `width` | number | ✅ | Crop width |
| `height` | number | ✅ | Crop height |
| `savePath` | string | | Path to save (defaults to overwrite source) |

---

## Layer Management

#### `add_layer`
Add a new layer (image or group) to a sprite.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `layerName` | string | ✅ | Name for the new layer |
| `isGroup` | boolean | | Create a group/folder layer (default: `false`) |
| `savePath` | string | | Path to save |

#### `remove_layer`
Remove a layer by name. Searches recursively through groups.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `layerName` | string | ✅ | Name of the layer to remove |
| `savePath` | string | | Path to save |

#### `list_layers`
List all layers in a sprite with full properties (name, visibility, opacity, blend mode, group children).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |

#### `set_layer_properties`
Modify a layer's properties. Only specified properties are changed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `layerName` | string | ✅ | Layer to modify |
| `newName` | string | | Rename the layer |
| `visible` | boolean | | Set visibility |
| `opacity` | number | | Set opacity (0–255) |
| `blendMode` | string | | Blend mode (see below) |
| `savePath` | string | | Path to save |

**Blend modes:** `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color_dodge`, `color_burn`, `hard_light`, `soft_light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`

---

## Frames & Animation

#### `add_frame`
Add one or more frames to a sprite.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `count` | number | | Number of frames to add (default: 1) |
| `afterFrame` | number | | Insert after this frame (1-indexed). Omit to append. |
| `empty` | boolean | | Create empty frames (default: `false`, copies previous frame content) |
| `savePath` | string | | Path to save |

#### `remove_frame`
Remove a frame from a sprite.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `frameNumber` | number | ✅ | Frame to remove (1-indexed) |
| `savePath` | string | | Path to save |

#### `set_frame_duration`
Set how long a frame displays during animation playback.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `frameNumber` | number | ✅ | Frame number (1-indexed) |
| `durationMs` | number | ✅ | Duration in milliseconds |
| `savePath` | string | | Path to save |

#### `list_frames`
List all frames with their durations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |

---

## Animation Tags

Tags label ranges of frames as named animations (e.g., "walk", "idle", "attack").

#### `create_tag`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `tagName` | string | ✅ | Name for the tag |
| `fromFrame` | number | ✅ | Start frame (1-indexed) |
| `toFrame` | number | ✅ | End frame (1-indexed) |
| `aniDir` | string | | `"forward"` (default), `"reverse"`, `"pingpong"`, `"pingpong_reverse"` |
| `color` | string | | Tag color as hex `#RRGGBB` |
| `savePath` | string | | Path to save |

#### `remove_tag`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `tagName` | string | ✅ | Tag name to remove |
| `savePath` | string | | Path to save |

#### `list_tags`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |

---

## Drawing & Pixel Operations

All drawing tools target a specific layer and frame. If `layerName` is omitted, the first layer is used. If `frameNumber` is omitted, frame 1 is used.

#### `draw_pixels`
Draw individual pixels at specific coordinates.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `pixels` | array | ✅ | Array of `{ x, y, color }` objects |
| `layerName` | string | | Target layer |
| `frameNumber` | number | | Frame (1-indexed, default: 1) |
| `savePath` | string | | Path to save |

#### `draw_rect`
Draw a rectangle (filled or outline).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `x` | number | ✅ | Left edge |
| `y` | number | ✅ | Top edge |
| `width` | number | ✅ | Rectangle width |
| `height` | number | ✅ | Rectangle height |
| `color` | | ✅ | Fill/stroke color |
| `filled` | boolean | | Fill the rectangle (default: `true`) |
| `thickness` | number | | Stroke thickness (default: `1`). Uses native Aseprite brush when > 1. |
| `layerName` | string | | Target layer |
| `frameNumber` | number | | Frame (1-indexed, default: 1) |
| `savePath` | string | | Path to save |

#### `draw_circle`
Draw a circle (filled or outline).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `centerX` | number | ✅ | Center X coordinate |
| `centerY` | number | ✅ | Center Y coordinate |
| `radius` | number | ✅ | Circle radius |
| `color` | | ✅ | Fill/stroke color |
| `filled` | boolean | | Fill the circle (default: `true`) |
| `thickness` | number | | Stroke thickness (default: `1`). Uses native Aseprite brush when > 1. |
| `layerName` | string | | Target layer |
| `frameNumber` | number | | Frame (1-indexed, default: 1) |
| `savePath` | string | | Path to save |

#### `draw_line`
Draw a line between two points.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `x1` | number | ✅ | Start X |
| `y1` | number | ✅ | Start Y |
| `x2` | number | ✅ | End X |
| `y2` | number | ✅ | End Y |
| `color` | | ✅ | Line color |
| `thickness` | number | | Thickness (default: `1`). Uses native Aseprite brush when > 1. |
| `layerName` | string | | Target layer |
| `frameNumber` | number | | Frame (1-indexed, default: 1) |
| `savePath` | string | | Path to save |

#### `draw_ellipse`
Draw an ellipse using Aseprite's native ellipse tool.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `x` | number | ✅ | Left edge of bounding box |
| `y` | number | ✅ | Top edge of bounding box |
| `width` | number | ✅ | Ellipse width |
| `height` | number | ✅ | Ellipse height |
| `color` | | ✅ | Fill/stroke color |
| `filled` | boolean | | Fill the ellipse (default: `true`) |
| `thickness` | number | | Stroke thickness (default: `1`) |
| `layerName` | string | | Target layer |
| `frameNumber` | number | | Frame (1-indexed, default: 1) |
| `savePath` | string | | Path to save |

#### `fill_area`
Flood fill an area using the native paint bucket tool.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `x` | number | ✅ | Fill origin X |
| `y` | number | ✅ | Fill origin Y |
| `color` | | ✅ | Fill color |
| `tolerance` | number | | Color tolerance 0–255 (default: `0`) |
| `contiguous` | boolean | | Only fill connected pixels (default: `true`) |
| `layerName` | string | | Target layer |
| `frameNumber` | number | | Frame (1-indexed, default: 1) |
| `savePath` | string | | Path to save |

#### `outline`
Add an outline around non-transparent pixels on a layer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `color` | | ✅ | Outline color |
| `layerName` | string | | Target layer |
| `frameNumber` | number | | Frame (1-indexed, default: 1) |
| `savePath` | string | | Path to save |

---

## Transform & Color

#### `replace_color`
Replace all occurrences of one color with another.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `fromColor` | | ✅ | Color to replace |
| `toColor` | | ✅ | Replacement color |
| `layerName` | string | | Limit to this layer |
| `frameNumber` | number | | Limit to this frame |
| `tolerance` | number | | Match tolerance 0–255 (default: `0`) |
| `savePath` | string | | Path to save |

#### `flip_sprite`
Flip the entire canvas horizontally or vertically.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `direction` | string | ✅ | `"horizontal"` or `"vertical"` |
| `savePath` | string | | Path to save |

#### `rotate_sprite`
Rotate the entire canvas.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `angle` | number | ✅ | `90`, `180`, or `270` degrees |
| `savePath` | string | | Path to save |

#### `flatten_layers`
Flatten all layers into a single layer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `savePath` | string | | Path to save |

#### `merge_down`
Merge a layer with the layer directly below it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `layerName` | string | ✅ | Layer to merge down |
| `savePath` | string | | Path to save |

---

## Palette

#### `get_palette`
Get all colors in a sprite's palette. Returns array of `{ index, r, g, b, a }`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |

#### `set_palette_colors`
Set specific colors in a sprite's palette by index.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `colors` | array | ✅ | Array of `{ index, r, g, b, a? }` objects |
| `savePath` | string | | Path to save |

#### `load_palette`
Load a palette from an external file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `palettePath` | string | ✅ | Palette file (`.gpl`, `.pal`, `.aseprite`, `.png`, etc.) |
| `savePath` | string | | Path to save |

#### `resize_palette`
Resize a palette to a new number of entries.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `newSize` | number | ✅ | New number of palette entries |
| `savePath` | string | | Path to save |

---

## Cel Operations

A **cel** is the pixel content at a specific layer × frame intersection.

#### `move_cel`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `layerName` | string | ✅ | Layer name |
| `x` | number | ✅ | New X position |
| `y` | number | ✅ | New Y position |
| `frameNumber` | number | | Frame (1-indexed, default: 1) |
| `savePath` | string | | Path to save |

#### `set_cel_opacity`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `layerName` | string | ✅ | Layer name |
| `opacity` | number | ✅ | Opacity (0–255) |
| `frameNumber` | number | | Frame (1-indexed, default: 1) |
| `savePath` | string | | Path to save |

#### `clear_cel`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `layerName` | string | ✅ | Layer name |
| `frameNumber` | number | | Frame (1-indexed, default: 1) |
| `savePath` | string | | Path to save |

---

## Export

#### `export_sprite_sheet`
Export as a sprite sheet with optional JSON metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Source sprite file |
| `outputImage` | string | ✅ | Output image path (`.png`) |
| `dataFile` | string | | Output JSON data file |
| `sheetType` | string | | `"horizontal"`, `"vertical"`, `"rows"` (default), `"columns"`, `"packed"` |
| `columns` | number | | Fixed column count |
| `rows` | number | | Fixed row count |
| `borderPadding` | number | | Padding on texture borders |
| `shapePadding` | number | | Padding between frames |
| `innerPadding` | number | | Padding inside each frame |
| `trim` | boolean | | Trim transparent edges |
| `mergeDuplicates` | boolean | | Merge identical frames |
| `layer` | string | | Export only this layer |
| `tag` | string | | Export only this animation tag |
| `splitLayers` | boolean | | Split layers into separate images |

#### `export_frame`
Export a single frame as an image file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Source sprite file |
| `outputPath` | string | ✅ | Output image path |
| `frameNumber` | number | | Frame to export (1-indexed, default: 1) |
| `layerName` | string | | Export only this layer |

#### `export_layers`
Export each layer as a separate image file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Source sprite file |
| `outputPattern` | string | ✅ | Output path with `{layer}` placeholder (e.g. `"output-{layer}.png"`) |
| `frameNumber` | number | | Export this frame only (1-indexed) |

---

## Slices

Slices define named rectangular regions within a sprite (9-slice scaling, UI extraction).

#### `create_slice`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `sliceName` | string | ✅ | Name for the slice |
| `x` | number | ✅ | Left edge |
| `y` | number | ✅ | Top edge |
| `width` | number | ✅ | Slice width |
| `height` | number | ✅ | Slice height |
| `pivotX` | number | | Pivot X coordinate |
| `pivotY` | number | | Pivot Y coordinate |
| `savePath` | string | | Path to save |

#### `remove_slice`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | Sprite file |
| `sliceName` | string | ✅ | Slice name to remove |
| `savePath` | string | | Path to save |

---

## Aseprite Codex Bridge

These tools use the optional Aseprite Codex Bridge extension. The extension writes
active editor context to a shared `state.json` file and can save an
`active-sprite.aseprite` snapshot in the same bridge folder.

Set `ASEPRITE_MCP_BRIDGE_DIR` for both Aseprite and the MCP server if you want
to override the default `<system temp>/aseprite-mcp-bridge` folder.

#### `get_bridge_status`
Read the bridge status file if it exists.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| none | | | |

**Returns:** bridge directory, state path, snapshot path, active sprite file if available, and the raw bridge state.

#### `get_active_sprite_context`
Read the active sprite, active layer, active frame, selection, and snapshot context written by the extension.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| none | | | |

#### `get_active_sprite_info`
Resolve the active saved sprite or snapshot from the bridge state, then return full `get_sprite_info` metadata for that file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| none | | | |

#### `save_active_sprite_copy`
Save a copy of the active saved sprite or snapshot reported by the bridge.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `savePath` | string | | Destination path. Defaults to `active-sprite-copy.aseprite` in the bridge folder. |

#### `run_script_on_active_sprite`
Execute Lua with the active saved sprite or snapshot opened first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `script` | string | ✅ | Lua script code to execute |

The script controls whether changes are saved. Use `app.activeSprite:saveCopyAs(...)`
inside the script for generated outputs.

---

## Utility

#### `run_script`
Execute arbitrary Lua code in Aseprite's scripting environment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `script` | string | ✅ | Lua script code |
| `filePath` | string | | Sprite file to open before running |

See the [Aseprite Scripting API](https://www.aseprite.org/api/) for available Lua objects and methods.

#### `get_aseprite_version`
Get the installed Aseprite version. No parameters.
