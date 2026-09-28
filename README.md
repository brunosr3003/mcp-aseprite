# mcp-aseprite

An [MCP](https://modelcontextprotocol.io) server that gives AI assistants (Claude Code, Claude Desktop, Cursor and any other MCP client) full control of [Aseprite](https://www.aseprite.org), the pixel-art editor.

It wraps both the Aseprite **command line** and its **Lua scripting API**, so an assistant can inspect sprites, export frames and spritesheets, create new files, and edit pixels, layers, frames, tags and palettes. All of it runs headless in batch mode, with no window.

```
You:    Create a 32x32 sprite with a 4-frame "idle" tag, then export it as a
        packed spritesheet with JSON metadata for my game.
Claude: → aseprite_create_sprite → aseprite_run_script → aseprite_export_spritesheet
        Done: hero.png + hero.json (4 frames, tag "idle" 0–3).
```

## Tools

| Tool | What it does |
|---|---|
| `aseprite_info` | Sprite metadata as JSON: size, color mode, frames, palette size, layers, tags, slices, frame durations |
| `aseprite_export` | Export to PNG/GIF/JPG… with frame range, layer filter, scale, color-mode conversion and split by layer/tag |
| `aseprite_export_spritesheet` | Pack into a spritesheet with JSON metadata (hash or array), trim, merge duplicates, 5 layouts |
| `aseprite_create_sprite` | Create a new `.aseprite` file (RGB, grayscale or indexed) with an optional background color |
| `aseprite_run_script` | Run arbitrary Lua against the [Aseprite API](https://aseprite.org/api/). Optionally opens a sprite first and saves it afterwards |
| `aseprite_run_script_file` | Same as above, for a `.lua` file already on disk |
| `aseprite_list_layers` | List layer names (optionally including hidden ones) |
| `aseprite_list_tags` | List animation tags |
| `aseprite_list_slices` | List slices |
| `aseprite_cli` | Escape hatch: run the Aseprite binary with any arguments |

`aseprite_run_script` is where the power is: anything the Aseprite scripting API can do (drawing pixels, adding frames, applying palettes, resizing, building animations) is available to the assistant. Output from Lua `print()` comes back as the tool result.

## Requirements

- [Aseprite](https://www.aseprite.org) v1.2.10 or newer (Steam or standalone). The trial version has no CLI and will not work.
- Node.js 18+

## Installation

```sh
git clone https://github.com/brunosr3003/mcp-aseprite.git
cd mcp-aseprite
npm install
```

### Claude Code

```sh
claude mcp add aseprite --scope user -- node /absolute/path/to/mcp-aseprite/index.js
```

### Claude Desktop, Cursor and other clients

Add this to the client's MCP config (for example `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "aseprite": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-aseprite/index.js"]
    }
  }
}
```

## Finding Aseprite

The server looks for the Aseprite binary in the usual Steam and standalone install locations:

| OS | Checked paths |
|---|---|
| macOS | `~/Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app`, `/Applications/Aseprite.app`, `~/Applications/Aseprite.app` |
| Windows | `Program Files (x86)\Steam\...\Aseprite.exe`, `Program Files\Steam\...\Aseprite.exe`, `Program Files\Aseprite\Aseprite.exe` |
| Linux | `~/.steam/steam/...`, `~/.local/share/Steam/...`, `/usr/bin/aseprite`, `/usr/local/bin/aseprite` |

If none of these exist it falls back to `aseprite` on your `PATH`. To point to a custom location, set `ASEPRITE_BIN`:

```json
{
  "mcpServers": {
    "aseprite": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-aseprite/index.js"],
      "env": { "ASEPRITE_BIN": "/path/to/aseprite" }
    }
  }
}
```

## Notes

- Use **absolute paths** for every file argument. Relative paths resolve against the server's working directory, not yours.
- Frame numbers in tool arguments and in `aseprite_info` output are **0-indexed**. Inside Lua scripts the Aseprite API is 1-indexed as usual.
- Each call runs a fresh Aseprite process, so state does not carry over between calls. To keep changes, save within the same call (`save: true`, `saveAs`, or `sprite:saveAs()` in your script).
- `aseprite_run_script` executes arbitrary Lua with Aseprite's permissions, including file access. Only connect this server to assistants you trust.

## License

[MIT](LICENSE) © Bruno Soares Reis

Aseprite is a trademark of Igara Studio S.A. This project is not affiliated with or endorsed by Igara Studio.
