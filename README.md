# Multiplexer

A small terminal UI for starting and monitoring multiple tools from `tools.json`.

## Run

```powershell
npm start
```

## Slow terminals

For VDI or slow remote terminals, reduce refresh frequency by increasing `ACTIVE_OUTPUT_REFRESH_MS` near the top of `multiplexer.js`.

## Tool config

Tools are loaded from `tools.json`:

```json
{
  "name": "calculate_age",
  "command": "bash",
  "args": ["./calculate_age.sh"],
  "cwd": "."
}
```

Hidden action tools can be referenced from visible tools:

```json
{
  "name": "check_almahari_status",
  "command": "bash",
  "args": ["./check_almahari_status.sh"],
  "cwd": ".",
  "actions": ["open_almahari", "open_almahari_github"]
}
```

```json
{
  "name": "open_almahari",
  "command": "cmd",
  "args": ["/c", "start", "", "https://almahari.com"],
  "cwd": ".",
  "hidden": true
}
```

Set `"autoClose": true` to close a script or action tab automatically when its command exits.

Visible placeholder tools can omit `command` when they only exist to group actions:

```json
{
  "name": "almahari",
  "cwd": ".",
  "actions": ["open_almahari", "open_almahari_github"]
}
```

## Shortcuts

Selection screen:

- Type to filter the script list
- `Backspace`: edit the filter
- `Up` / `Down`: move
- `Space`: select or unselect a tool
- `Enter`: start selected tools
- `Esc`: clear the filter, or return to running tabs
- `Ctrl+Q`: quit

Running screen:

- `Tab`: switch active tool
- `Ctrl+1` through `Ctrl+9`: switch directly to that tab
- `Alt+1` through `Alt+9`: fallback direct tab switch for terminals that do not emit Ctrl-number keys
- `Ctrl+A`: run the active tool's action, or open an action picker when multiple actions exist
- `Ctrl+R`: rerun the active tool
- `Ctrl+W`: close the active tab; closing a parent tab also closes its action tabs
- `Ctrl+N`: open the tool selector and start more tools
- `Ctrl+S` or `Ctrl+X`: stop the active tool
- `Ctrl+L`: clear active output
- `Up` / `Down`: scroll output
- `PageUp` / `PageDown`: scroll faster
- `Enter`: send the input line to the active tool
- `Esc`: clear the input line
- `Ctrl+Q` or `Ctrl+C`: quit
