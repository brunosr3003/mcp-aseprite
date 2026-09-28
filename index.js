#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

// Common install locations (Steam and standalone) per platform. Falls back to
// `aseprite` on PATH. Override with the ASEPRITE_BIN env var.
function defaultAsepriteCandidates() {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return [
        path.join(home, "Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app/Contents/MacOS/aseprite"),
        "/Applications/Aseprite.app/Contents/MacOS/aseprite",
        path.join(home, "Applications/Aseprite.app/Contents/MacOS/aseprite"),
      ];
    case "win32":
      return [
        "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Aseprite\\Aseprite.exe",
        "C:\\Program Files\\Steam\\steamapps\\common\\Aseprite\\Aseprite.exe",
        "C:\\Program Files\\Aseprite\\Aseprite.exe",
      ];
    default:
      return [
        path.join(home, ".steam/steam/steamapps/common/Aseprite/aseprite"),
        path.join(home, ".local/share/Steam/steamapps/common/Aseprite/aseprite"),
        "/usr/bin/aseprite",
        "/usr/local/bin/aseprite",
      ];
  }
}

const ASEPRITE_BIN =
  process.env.ASEPRITE_BIN ||
  defaultAsepriteCandidates().find((p) => existsSync(p)) ||
  "aseprite";

async function runAseprite(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(ASEPRITE_BIN, args, {
      maxBuffer: 64 * 1024 * 1024,
      cwd: opts.cwd,
      env: { ...process.env, ASEPRITE_USER_FOLDER: process.env.ASEPRITE_USER_FOLDER || undefined },
    });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? String(e),
      code: e.code ?? 1,
    };
  }
}

async function withTempLua(script, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "aseprite-mcp-"));
  const luaPath = path.join(dir, "script.lua");
  await writeFile(luaPath, script, "utf8");
  try {
    return await fn(luaPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(r, label = "aseprite failed") {
  const body = `${label} (exit ${r.code})\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
  return { content: [{ type: "text", text: body }], isError: true };
}

function luaStr(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

const INFO_LUA = `
local s = app.sprite
if not s then print("ERROR: no sprite open") return end
local function esc(str)
  str = tostring(str or "")
  return str:gsub("\\\\","\\\\\\\\"):gsub('"','\\\\"'):gsub("\\n","\\\\n")
end

local cm = "indexed"
if s.colorMode == ColorMode.RGB then cm = "rgb"
elseif s.colorMode == ColorMode.GRAY then cm = "gray" end

local pal_size = 0
pcall(function() pal_size = #(s.palettes[1]) end)

local out = {}
table.insert(out, "{")
table.insert(out, '"filename":"' .. esc(s.filename) .. '",')
table.insert(out, '"width":' .. s.width .. ",")
table.insert(out, '"height":' .. s.height .. ",")
table.insert(out, '"colorMode":"' .. cm .. '",')
table.insert(out, '"frames":' .. #s.frames .. ",")
table.insert(out, '"paletteSize":' .. pal_size .. ",")

table.insert(out, '"layers":[')
for i, l in ipairs(s.layers) do
  if i > 1 then table.insert(out, ",") end
  local kind = l.isGroup and "group" or (l.isImage and "image" or "other")
  table.insert(out, string.format('{"name":"%s","visible":%s,"kind":"%s"}',
    esc(l.name), tostring(l.isVisible), kind))
end
table.insert(out, "],")

table.insert(out, '"tags":[')
for i, t in ipairs(s.tags) do
  if i > 1 then table.insert(out, ",") end
  table.insert(out, string.format('{"name":"%s","from":%d,"to":%d}',
    esc(t.name), t.fromFrame.frameNumber - 1, t.toFrame.frameNumber - 1))
end
table.insert(out, "],")

table.insert(out, '"slices":[')
for i, sl in ipairs(s.slices) do
  if i > 1 then table.insert(out, ",") end
  table.insert(out, string.format('{"name":"%s"}', esc(sl.name)))
end
table.insert(out, "],")

table.insert(out, '"frameDurations":[')
for i, f in ipairs(s.frames) do
  if i > 1 then table.insert(out, ",") end
  table.insert(out, tostring(f.duration))
end
table.insert(out, "]")

table.insert(out, "}")
print("__JSON__" .. table.concat(out))
`;

const TOOLS = [
  {
    name: "aseprite_info",
    description:
      "Get sprite metadata as JSON: filename, width, height, colorMode, frames count, paletteSize, layers (name/visible/kind), tags (name/from/to, 0-indexed), slices, per-frame durations (seconds). Pass an absolute path.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Absolute path to .aseprite/.ase/.png/etc." },
      },
      required: ["file"],
    },
  },
  {
    name: "aseprite_export",
    description:
      "Export sprite to image (PNG, GIF, JPG…). Format inferred from output extension. Supports frame range, layer filter, scale, color-mode conversion, splitting.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Source sprite (absolute path)" },
        output: { type: "string", description: "Destination path. For multi-file exports use filename pattern with {frame}/{tag}/{layer} placeholders." },
        frame: { type: "string", description: "Frame range, e.g. '0', '1,3,5', '0-7' (0-indexed)." },
        layer: { type: "string", description: "Only export this layer." },
        ignoreLayer: { type: "string", description: "Hide this layer during export." },
        scale: { type: "number", description: "Output scale multiplier." },
        colorMode: { type: "string", enum: ["rgb", "gray", "indexed"] },
        splitLayers: { type: "boolean" },
        splitTags: { type: "boolean" },
        filenameFormat: { type: "string", description: "Pattern, e.g. '{title}_{tag}_{frame}.{extension}'." },
      },
      required: ["input", "output"],
    },
  },
  {
    name: "aseprite_export_spritesheet",
    description:
      "Pack sprite as a spritesheet (PNG) with optional JSON metadata describing frame coords, tags, slices. Ideal for game engines.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string" },
        outputImage: { type: "string", description: "Spritesheet PNG path." },
        outputData: { type: "string", description: "JSON metadata path. Optional." },
        sheetType: {
          type: "string",
          enum: ["horizontal", "vertical", "rows", "columns", "packed"],
          description: "Default: packed.",
        },
        dataFormat: { type: "string", enum: ["json-hash", "json-array"], description: "Default: json-array." },
        scale: { type: "number" },
        trim: { type: "boolean", description: "Trim transparent pixels around frames." },
        mergeDuplicates: { type: "boolean" },
        splitLayers: { type: "boolean" },
        splitTags: { type: "boolean" },
        ignoreEmpty: { type: "boolean" },
      },
      required: ["input", "outputImage"],
    },
  },
  {
    name: "aseprite_create_sprite",
    description: "Create a new empty sprite file (.aseprite). Optionally fill background.",
    inputSchema: {
      type: "object",
      properties: {
        output: { type: "string", description: "Destination .aseprite path." },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        colorMode: { type: "string", enum: ["rgb", "gray", "indexed"], description: "Default: rgb." },
        backgroundColor: { type: "string", description: "Hex color e.g. '#1a1a1a'. Omit for transparent." },
      },
      required: ["output", "width", "height"],
    },
  },
  {
    name: "aseprite_run_script",
    description:
      "MAXIMUM POWER tool — run arbitrary Lua against the Aseprite scripting API. Can read/write any sprite, modify pixels, layers, frames, palettes, apply filters, etc. If `file` is set, the sprite is opened first and accessible as `app.sprite`. Stdout from Lua `print()` is captured. API ref: https://aseprite.org/api/",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Lua source code." },
        file: { type: "string", description: "Optional sprite to open before running script." },
        save: { type: "boolean", description: "If true and `file` is set, save sprite (overwrites) after script." },
        saveAs: { type: "string", description: "If set, save sprite to this path after script." },
        params: {
          type: "object",
          description: "Key/value params accessible in Lua via `app.params[key]`. Values must be strings.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["script"],
    },
  },
  {
    name: "aseprite_run_script_file",
    description: "Run a Lua script that already exists on disk. Same options as aseprite_run_script.",
    inputSchema: {
      type: "object",
      properties: {
        scriptPath: { type: "string", description: "Absolute path to .lua file." },
        file: { type: "string" },
        save: { type: "boolean" },
        saveAs: { type: "string" },
        params: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["scriptPath"],
    },
  },
  {
    name: "aseprite_list_layers",
    description: "List layer names of a sprite (one per line).",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        all: { type: "boolean", description: "Include hidden layers (--all-layers)." },
      },
      required: ["file"],
    },
  },
  {
    name: "aseprite_list_tags",
    description: "List animation tag names of a sprite.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
    },
  },
  {
    name: "aseprite_list_slices",
    description: "List slice names of a sprite.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
    },
  },
  {
    name: "aseprite_cli",
    description:
      "Raw CLI escape hatch. Runs the Aseprite binary with arbitrary args (prefixed with --batch by default). Use when other tools don't cover what you need. Returns full stdout/stderr.",
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, description: "Arg vector, e.g. ['--save-as','out.png','in.aseprite']" },
        cwd: { type: "string", description: "Working directory." },
        noBatch: { type: "boolean", description: "Don't auto-prepend --batch." },
      },
      required: ["args"],
    },
  },
];

async function infoTool({ file }) {
  return withTempLua(INFO_LUA, async (luaPath) => {
    const r = await runAseprite(["-b", file, "--script", luaPath]);
    if (!r.ok) return errorResult(r);
    const marker = r.stdout.split("\n").find((l) => l.startsWith("__JSON__"));
    if (!marker) return textResult(r.stdout);
    const json = marker.replace("__JSON__", "");
    try {
      return textResult(JSON.stringify(JSON.parse(json), null, 2));
    } catch {
      return textResult(json);
    }
  });
}

async function exportTool({
  input,
  output,
  frame,
  layer,
  ignoreLayer,
  scale,
  colorMode,
  splitLayers,
  splitTags,
  filenameFormat,
}) {
  const args = ["-b", input];
  if (frame) args.push("--frame-range", frame);
  if (layer) args.push("--layer", layer);
  if (ignoreLayer) args.push("--ignore-layer", ignoreLayer);
  if (scale) args.push("--scale", String(scale));
  if (colorMode) args.push("--color-mode", colorMode);
  if (splitLayers) args.push("--split-layers");
  if (splitTags) args.push("--split-tags");
  if (filenameFormat) args.push("--filename-format", filenameFormat);
  args.push("--save-as", output);
  const r = await runAseprite(args);
  if (!r.ok) return errorResult(r);
  return textResult(`exported: ${input} -> ${output}\n${r.stdout}${r.stderr ? "\n[stderr] " + r.stderr : ""}`);
}

async function sheetTool({
  input,
  outputImage,
  outputData,
  sheetType = "packed",
  dataFormat = "json-array",
  scale,
  trim,
  mergeDuplicates,
  splitLayers,
  splitTags,
  ignoreEmpty,
}) {
  const args = ["-b", input];
  if (scale) args.push("--scale", String(scale));
  if (splitLayers) args.push("--split-layers");
  if (splitTags) args.push("--split-tags");
  if (trim) args.push("--trim");
  if (mergeDuplicates) args.push("--merge-duplicates");
  if (ignoreEmpty) args.push("--ignore-empty");
  args.push("--sheet", outputImage, "--sheet-type", sheetType);
  if (outputData) args.push("--data", outputData, "--format", dataFormat);
  const r = await runAseprite(args);
  if (!r.ok) return errorResult(r);
  const lines = [`spritesheet -> ${outputImage}`];
  if (outputData) lines.push(`metadata -> ${outputData}`);
  if (r.stdout.trim()) lines.push(r.stdout.trim());
  return textResult(lines.join("\n"));
}

async function createSpriteTool({ output, width, height, colorMode = "rgb", backgroundColor }) {
  const cmEnum =
    colorMode === "gray" ? "ColorMode.GRAY" : colorMode === "indexed" ? "ColorMode.INDEXED" : "ColorMode.RGB";
  let lua = `local s = Sprite(${width}, ${height}, ${cmEnum})\n`;
  if (backgroundColor) {
    const hex = backgroundColor.replace(/[^0-9a-fA-F]/g, "");
    if (hex.length !== 6) {
      return textResult(`bad backgroundColor (need 6 hex chars): ${backgroundColor}`);
    }
    lua += `local r,g,b = 0x${hex.slice(0, 2)}, 0x${hex.slice(2, 4)}, 0x${hex.slice(4, 6)}\n`;
    lua += `local img = s.cels[1].image\n`;
    lua += `local color = app.pixelColor.rgba(r, g, b, 255)\n`;
    lua += `for it in img:pixels() do it(color) end\n`;
  }
  lua += `s:saveAs(${luaStr(output)})\n`;
  lua += `print("created: " .. ${luaStr(output)})\n`;
  return withTempLua(lua, async (luaPath) => {
    const r = await runAseprite(["-b", "--script", luaPath]);
    if (!r.ok) return errorResult(r);
    return textResult(r.stdout.trim() || `created: ${output}`);
  });
}

async function runScriptCommon({ luaPath, file, params }) {
  const args = ["-b"];
  if (file) args.push(file);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      args.push("--script-param", `${k}=${v}`);
    }
  }
  args.push("--script", luaPath);
  const r = await runAseprite(args);
  if (!r.ok) return errorResult(r);

  return textResult(`exit ${r.code}\n${r.stdout}${r.stderr ? "\n[stderr] " + r.stderr : ""}`);
}

async function runScriptTool({ script, file, save, saveAs, params }) {
  // Saving must happen in the same Aseprite process as the script, so append it.
  let finalScript = script;
  if (saveAs) {
    finalScript += `\n-- mcp auto saveAs\nif app.sprite then app.sprite:saveAs(${luaStr(saveAs)}) end\n`;
  } else if (save && file) {
    finalScript += `\n-- mcp auto save\nif app.sprite then app.sprite:saveAs(app.sprite.filename) end\n`;
  }
  return withTempLua(finalScript, (luaPath) =>
    runScriptCommon({ luaPath, file, params })
  );
}

async function runScriptFileTool({ scriptPath, file, save, saveAs, params }) {
  if (save || saveAs) {
    // Append the save step to a temp copy so it runs in the same Aseprite process.
    const userScript = await readFile(scriptPath, "utf8");
    const tail = saveAs
      ? `\n-- mcp auto saveAs\nif app.sprite then app.sprite:saveAs(${luaStr(saveAs)}) end\n`
      : `\n-- mcp auto save\nif app.sprite then app.sprite:saveAs(app.sprite.filename) end\n`;
    return withTempLua(userScript + tail, (luaPath) =>
      runScriptCommon({ luaPath, file, params })
    );
  }
  return runScriptCommon({ luaPath: scriptPath, file, params });
}

async function listLayersTool({ file, all }) {
  const args = ["-b"];
  if (all) args.push("--all-layers");
  args.push("--list-layers", file);
  const r = await runAseprite(args);
  if (!r.ok) return errorResult(r);
  return textResult(r.stdout.trim() || "(no layers)");
}

async function listTagsTool({ file }) {
  const r = await runAseprite(["-b", "--list-tags", file]);
  if (!r.ok) return errorResult(r);
  return textResult(r.stdout.trim() || "(no tags)");
}

async function listSlicesTool({ file }) {
  const r = await runAseprite(["-b", "--list-slices", file]);
  if (!r.ok) return errorResult(r);
  return textResult(r.stdout.trim() || "(no slices)");
}

async function cliTool({ args, cwd, noBatch }) {
  const finalArgs = noBatch ? args : ["-b", ...args];
  const r = await runAseprite(finalArgs, { cwd });
  const head = `aseprite ${finalArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
  return textResult(
    `${head}\nexit ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`
  );
}

const DISPATCH = {
  aseprite_info: infoTool,
  aseprite_export: exportTool,
  aseprite_export_spritesheet: sheetTool,
  aseprite_create_sprite: createSpriteTool,
  aseprite_run_script: runScriptTool,
  aseprite_run_script_file: runScriptFileTool,
  aseprite_list_layers: listLayersTool,
  aseprite_list_tags: listTagsTool,
  aseprite_list_slices: listSlicesTool,
  aseprite_cli: cliTool,
};

const server = new Server(
  { name: "aseprite", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = DISPATCH[name];
  if (!handler) {
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
  try {
    return await handler(args ?? {});
  } catch (e) {
    return {
      content: [{ type: "text", text: `tool ${name} threw: ${e?.stack || e}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
