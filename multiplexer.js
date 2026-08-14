#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const root = process.cwd();
const toolsFile = path.join(root, "tools.json");
const maxLines = 2000;

let tools = [];
let visibleTools = [];
let sessions = [];
let active = 0;
let mode = "select";
let selector = 0;
let selected = new Set();
let actionSelector = 0;
let actionSessionIndex = null;
let input = "";
let scroll = 0;
let quitRequested = false;

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  black: "\x1b[30m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  inverse: "\x1b[7m",
  bg: "",
  bgDark: "",
  bgBlue: "\x1b[48;2;137;184;235m",
  fgMuted: "\x1b[38;2;139;143;158m",
  fgBorder: "\x1b[38;2;137;184;235m",
  fgPanelBorder: "\x1b[38;2;60;64;77m",
};

function loadTools() {
  const raw = fs.readFileSync(toolsFile, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("tools.json must contain an array of tools.");
  }

  tools = parsed.map((tool, index) => {
    const actions = Array.isArray(tool.actions) ? tool.actions.map(String) : [];
    if (!tool.name || (!tool.command && actions.length === 0)) {
      throw new Error(`Tool at index ${index} must include name and either command or actions.`);
    }

    return {
      name: String(tool.name),
      command: tool.command ? String(tool.command) : null,
      args: Array.isArray(tool.args) ? tool.args.map(String) : [],
      cwd: path.resolve(root, tool.cwd || "."),
      env: tool.env && typeof tool.env === "object" ? tool.env : {},
      hidden: Boolean(tool.hidden),
      actions,
      autoClose: Boolean(tool.autoClose),
    };
  });
  visibleTools = tools.filter((tool) => !tool.hidden);
}

function terminalSize() {
  return {
    columns: Math.max(40, process.stdout.columns || 100),
    rows: Math.max(15, process.stdout.rows || 30),
  };
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function stripUnsafeAnsi(value) {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, (sequence) => sequence.endsWith("m") ? sequence : "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "");
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function fit(value, width) {
  const plain = stripAnsi(value);
  if (plain.length <= width) {
    return value + " ".repeat(width - plain.length);
  }

  if (width <= 3) {
    return ".".repeat(Math.max(0, width));
  }

  return plain.slice(0, Math.max(0, width - 3)) + "...";
}

function move(row, column) {
  return `\x1b[${row};${column}H`;
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function writeAt(row, column, text) {
  process.stdout.write(move(row, column) + text);
}

function paintLine(row, width, color = colors.bg) {
  writeAt(row, 1, color + " ".repeat(width) + colors.reset);
}

function frame(x, y, width, height, focused) {
  const horizontal = "─".repeat(Math.max(0, width - 2));
  const border = focused ? colors.fgBorder : colors.fgPanelBorder;
  const top = `${border}╭${horizontal}╮${colors.reset}`;
  const bottom = `${border}╰${horizontal}╯${colors.reset}`;

  writeAt(y, x, top);
  for (let row = 1; row < height - 1; row += 1) {
    writeAt(y + row, x, `${border}│${colors.reset}${" ".repeat(width - 2)}${border}│${colors.reset}`);
  }
  writeAt(y + height - 1, x, bottom);
}

function box(x, y, width, height, title, focused) {
  frame(x, y, width, height, focused);
  if (title) {
    writeAt(y, x + 2, ` ${colors.bold}${fit(title, Math.max(0, width - 6)).trimEnd()}${colors.reset} `);
  }
}

function renderHeader(columns, title) {
  const cwd = process.cwd().replace(/\\/g, "/");
  paintLine(1, columns);
  writeAt(1, 2, `${colors.fgMuted}${fit(title, Math.max(0, Math.floor(columns / 2))).trimEnd()}${colors.reset}`);
  const right = fit(cwd, Math.max(0, Math.floor(columns / 2))).trimEnd();
  writeAt(1, Math.max(2, columns - visibleLength(right)), `${colors.fgMuted}${right}${colors.reset}`);
}

function renderFooter(columns, row, selectMode = false, hasActions = false) {
  const actionHelp = hasActions ? "    ctrl+a action" : "";
  const runHelp = `up/down scroll    tab tabs    ctrl+1..9 jump${actionHelp}    ctrl+r rerun    ctrl+w close    ctrl+s/ctrl+x stop    ctrl+n new    ctrl+q quit`;
  const selectHelp = "^/v move    space select    enter start    esc back    q quit";
  paintLine(row, columns, colors.bgDark);
  writeAt(row, 2, `${colors.fgMuted}${fit(selectMode ? selectHelp : runHelp, columns - 2)}${colors.reset}`);
}

function appendOutput(session, chunk) {
  const text = stripUnsafeAnsi(chunk.toString("utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = text.split("\n");

  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index];
    if (index === 0 && session.output.length > 0) {
      session.output[session.output.length - 1] += line;
    } else {
      session.output.push(line);
    }
  }

  if (session.output.length > maxLines) {
    session.output.splice(0, session.output.length - maxLines);
  }

  render();
}

function startTool(tool, replaceIndex = null, options = {}) {
  if (replaceIndex !== null && sessions[replaceIndex]?.status === "running") {
    stopSession(sessions[replaceIndex], false);
  }

  const session = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: tool.name,
    tool,
    output: [],
    status: "starting",
    exitCode: null,
    process: null,
    startedAt: new Date(),
    parentId: options.parentId || null,
    isAction: Boolean(options.isAction),
  };

  const previousActive = active;

  if (replaceIndex === null) {
    sessions.push(session);
    active = options.activate === false ? previousActive : sessions.length - 1;
  } else {
    sessions[replaceIndex] = session;
    active = replaceIndex;
  }

  if (active === sessions.indexOf(session)) {
    scroll = 0;
  }

  if (!tool.command) {
    session.status = "placeholder";
    session.output.push("Action-only placeholder.");
    session.output.push("Use Ctrl+A to open actions.");
    if (options.openActions !== false && tool.actions.length > 0) {
      mode = "action";
      actionSelector = 0;
      actionSessionIndex = sessions.indexOf(session);
    }
    render();
    return;
  }

  const child = spawn(tool.command, tool.args, {
    cwd: tool.cwd,
    env: { ...process.env, ...tool.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  session.process = child;
  session.status = "running";

  child.stdout.on("data", (chunk) => appendOutput(session, chunk));
  child.stderr.on("data", (chunk) => appendOutput(session, chunk));
  child.on("error", (error) => {
    session.status = "error";
    session.output.push(`Error: ${error.message}`);
    render();
  });
  child.on("exit", (code, signal) => {
    session.status = "stopped";
    session.exitCode = signal || code;
    session.output.push("");
    session.output.push(`[process exited: ${signal || code}]`);
    if (session.tool.autoClose) {
      const index = sessions.findIndex((item) => item.id === session.id);
      if (index !== -1) {
        sessions.splice(index, 1);
        active = Math.max(0, Math.min(active, sessions.length - 1));
        if (sessions.length === 0) {
          mode = "select";
        }
      }
    }
    render();
  });
}

function stopProcessTree(child) {
  if (!child || !child.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function stopSession(session, shouldRender = true) {
  if (!session || session.status !== "running" || !session.process) {
    return;
  }

  session.output.push("[stopping process]");
  session.status = "stopping";
  stopProcessTree(session.process);
  if (shouldRender) {
    render();
  }
}

function rerunSession(index) {
  const session = sessions[index];
  if (!session) {
    return;
  }

  startTool(session.tool, index);
}

function closeSession(index) {
  const session = sessions[index];
  if (!session) {
    return;
  }

  const idsToClose = new Set([session.id]);
  if (!session.parentId) {
    for (const child of sessions) {
      if (child.parentId === session.id) {
        idsToClose.add(child.id);
      }
    }
  }

  for (const item of sessions) {
    if (idsToClose.has(item.id)) {
      stopSession(item, false);
    }
  }

  sessions = sessions.filter((item) => !idsToClose.has(item.id));
  active = Math.max(0, Math.min(index, sessions.length - 1));
  scroll = 0;
  input = "";

  if (sessions.length === 0) {
    openSelector();
    return;
  }

  render();
}

function runActiveAction(index) {
  const session = sessions[index];
  const actions = session?.tool?.actions || [];
  if (!session || actions.length === 0) {
    return;
  }

  if (actions.length > 1) {
    mode = "action";
    actionSelector = 0;
    actionSessionIndex = index;
    input = "";
    render();
    return;
  }

  const actionTool = tools.find((tool) => tool.name === actions[0]);
  if (!actionTool) {
    session.output.push(`[action not found: ${actions[0]}]`);
    render();
    return;
  }

  startTool(actionTool, null, { parentId: session.id, isAction: true, activate: false });
}

function runSelectedAction() {
  const session = sessions[actionSessionIndex];
  const actionName = session?.tool?.actions?.[actionSelector];
  if (!session || !actionName) {
    mode = "run";
    render();
    return;
  }

  const actionTool = tools.find((tool) => tool.name === actionName);
  if (!actionTool) {
    session.output.push(`[action not found: ${actionName}]`);
    mode = "run";
    render();
    return;
  }

  mode = "run";
  active = actionSessionIndex;
  startTool(actionTool, null, { parentId: session.id, isAction: true, activate: false });
}

function displaySessionIndexes() {
  const ordered = [];
  const topLevel = sessions
    .map((session, index) => ({ session, index }))
    .filter((item) => !item.session.parentId);

  for (const item of topLevel) {
    ordered.push(item.index);
    for (let index = 0; index < sessions.length; index += 1) {
      if (sessions[index].parentId === item.session.id) {
        ordered.push(index);
      }
    }
  }

  for (let index = 0; index < sessions.length; index += 1) {
    if (sessions[index].parentId && !sessions.some((session) => session.id === sessions[index].parentId)) {
      ordered.push(index);
    }
  }

  return ordered;
}

function stopAll() {
  for (const session of sessions) {
    stopSession(session);
  }
}

function renderSelect() {
  const { columns, rows } = terminalSize();
  clearScreen();
  renderHeader(columns, "Dev TUI");
  renderFooter(columns, rows, true);

  const width = Math.min(columns - 8, 92);
  const height = Math.min(rows - 6, Math.max(12, visibleTools.length + 7));
  const x = Math.max(2, Math.floor((columns - width) / 2));
  const y = Math.max(3, Math.floor((rows - height) / 2));

  box(x, y, width, height, "Select Tools", true);
  writeAt(y + 2, x + 3, `${colors.white}${colors.bold}Choose tools to run${colors.reset}`);
  writeAt(y + 3, x + 3, `${colors.fgMuted}Space toggles multiple tools. Enter starts the selection.${colors.reset}`);

  const listTop = y + 5;
  const listHeight = height - 7;
  const start = Math.max(0, Math.min(selector - listHeight + 1, visibleTools.length - listHeight));
  const end = Math.min(visibleTools.length, start + listHeight);

  for (let index = start; index < end; index += 1) {
    const tool = visibleTools[index];
    const checked = selected.has(index) ? "[x]" : "[ ]";
    const command = tool.command ? `${tool.command} ${tool.args.join(" ")}`.trim() : "actions";
    const line = `${checked} ${tool.name}  ${colors.dim}${command}${colors.reset}`;
    const prefix = index === selector ? colors.bgBlue + colors.black : "";
    const suffix = index === selector ? colors.reset : "";
    writeAt(listTop + index - start, x + 3, prefix + fit(line, width - 6) + suffix);
  }
}

function renderActionSelect() {
  const { columns, rows } = terminalSize();
  const session = sessions[actionSessionIndex];
  const actions = (session?.tool?.actions || [])
    .map((name) => tools.find((tool) => tool.name === name))
    .filter(Boolean);

  clearScreen();
  renderHeader(columns, "Dev TUI");
  renderFooter(columns, rows, true);

  const width = Math.min(columns - 8, 76);
  const height = Math.min(rows - 6, Math.max(10, actions.length + 7));
  const x = Math.max(2, Math.floor((columns - width) / 2));
  const y = Math.max(3, Math.floor((rows - height) / 2));

  box(x, y, width, height, `Actions: ${session?.name || ""}`, true);
  writeAt(y + 2, x + 3, `${colors.white}${colors.bold}Choose an action to run${colors.reset}`);
  writeAt(y + 3, x + 3, `${colors.fgMuted}Enter runs the action. Esc returns to the active tab.${colors.reset}`);

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const command = action.command ? `${action.command} ${action.args.join(" ")}`.trim() : "actions";
    const line = `${action.name}  ${colors.dim}${command}${colors.reset}`;
    const prefix = index === actionSelector ? colors.bgBlue + colors.black : "";
    const suffix = index === actionSelector ? colors.reset : "";
    writeAt(y + 5 + index, x + 3, prefix + fit(line, width - 6) + suffix);
  }
}

function renderRun() {
  const { columns, rows } = terminalSize();
  clearScreen();
  renderHeader(columns, "Dev TUI");
  renderFooter(columns, rows, false, Boolean(sessions[active]?.tool?.actions?.length));

  const gap = 2;
  const top = 3;
  const bottom = rows - 2;
  const panelHeight = Math.max(8, bottom - top + 1);
  const listWidth = Math.min(30, Math.max(18, Math.floor(columns * 0.14)));
  const outputX = listWidth + gap + 1;
  const outputWidth = Math.max(20, columns - outputX);

  frame(1, top, listWidth, panelHeight, false);
  frame(outputX, top, outputWidth, panelHeight, true);

  const palette = [colors.cyan, colors.magenta, colors.red, colors.yellow, colors.green, colors.blue];
  const listHeight = panelHeight - 2;
  const displayIndexes = displaySessionIndexes();
  const activeDisplayIndex = Math.max(0, displayIndexes.indexOf(active));
  const listStart = Math.max(0, Math.min(activeDisplayIndex - listHeight + 1, displayIndexes.length - listHeight));

  for (let displayIndex = listStart; displayIndex < Math.min(displayIndexes.length, listStart + listHeight); displayIndex += 1) {
    const i = displayIndexes[displayIndex];
    const session = sessions[i];
    const status = session.status === "running" ? " " : "x";
    const color = session.status === "running" ? palette[i % palette.length] : colors.dim;
    const number = String(displayIndex + 1).padStart(2, " ");
    const indent = session.parentId ? "  " : "";
    const line = `${number} ${status} ${indent}${session.name}`;
    const prefix = i === active ? colors.bgBlue + colors.black : color;
    const suffix = colors.reset;
    writeAt(top + 1 + displayIndex - listStart, 2, prefix + fit(line, listWidth - 2) + suffix);
  }

  const session = sessions[active];
  if (session) {
    const command = session.tool.command ? `${session.tool.command} ${session.tool.args.join(" ")}`.trim() : session.name;
    writeAt(top + 1, outputX + 2, `${colors.fgMuted}${fit(command, outputWidth - 4)}${colors.reset}`);
    writeAt(top + 2, outputX + 1, `${colors.fgPanelBorder}${"-".repeat(outputWidth - 2)}${colors.reset}`);

    const outputTop = top + 4;
    const outputHeight = panelHeight - 6;
    const available = Math.max(0, session.output.length - outputHeight);
    scroll = Math.max(0, Math.min(scroll, available));
    const start = Math.max(0, session.output.length - outputHeight - scroll);
    const lines = session.output.slice(start, start + outputHeight);

    for (let row = 0; row < outputHeight; row += 1) {
      const line = lines[row] || "";
      writeAt(outputTop + row, outputX + 3, fit(line, outputWidth - 6));
    }

    if (input.length > 0) {
      writeAt(rows - 1, 2, `${colors.white}${fit(`input: ${input}`, columns - 2)}${colors.reset}`);
    }
  }
}

function render() {
  if (quitRequested) {
    return;
  }

  if (mode === "select") {
    renderSelect();
  } else if (mode === "action") {
    renderActionSelect();
  } else {
    renderRun();
  }
}

function openSelector() {
  mode = "select";
  selector = 0;
  selected = new Set();
  input = "";
  render();
}

function startSelected() {
  const indexes = selected.size > 0 ? [...selected] : [selector];
  for (const index of indexes) {
    if (visibleTools[index]) {
      startTool(visibleTools[index]);
    }
  }

  mode = "run";
  input = "";
  render();
}

function sendInput() {
  const session = sessions[active];
  if (!session || session.status !== "running" || !session.process?.stdin?.writable) {
    input = "";
    render();
    return;
  }

  session.output.push(`> ${input}`);
  session.process.stdin.write(input + "\n");
  input = "";
  render();
}

function handleSelectKey(str, key) {
  if (key.name === "up") {
    selector = Math.max(0, selector - 1);
  } else if (key.name === "down") {
    selector = Math.min(visibleTools.length - 1, selector + 1);
  } else if (key.name === "space") {
    if (selected.has(selector)) selected.delete(selector);
    else selected.add(selector);
  } else if (key.name === "return") {
    startSelected();
    return;
  } else if (str === "q" || (key.ctrl && key.name === "q") || (key.ctrl && key.name === "c")) {
    shutdown();
    return;
  } else if (key.name === "escape" && sessions.length > 0) {
    mode = "run";
  }

  render();
}

function handleActionKey(str, key) {
  const actionCount = sessions[actionSessionIndex]?.tool?.actions?.length || 0;

  if (key.name === "up") {
    actionSelector = Math.max(0, actionSelector - 1);
  } else if (key.name === "down") {
    actionSelector = Math.min(actionCount - 1, actionSelector + 1);
  } else if (key.name === "return") {
    runSelectedAction();
    return;
  } else if (key.name === "escape") {
    mode = "run";
  } else if (str === "q" || (key.ctrl && key.name === "q") || (key.ctrl && key.name === "c")) {
    shutdown();
    return;
  }

  render();
}

function handleRunKey(str, key) {
  if (key.name === "tab") {
    const displayIndexes = displaySessionIndexes();
    const current = Math.max(0, displayIndexes.indexOf(active));
    active = displayIndexes.length ? displayIndexes[(current + 1) % displayIndexes.length] : 0;
    scroll = 0;
  } else if ((key.ctrl || key.meta) && /^[1-9]$/.test(key.name || str || "")) {
    const displayIndexes = displaySessionIndexes();
    const displayIndex = Number(key.name || str) - 1;
    if (sessions[displayIndexes[displayIndex]]) {
      active = displayIndexes[displayIndex];
      scroll = 0;
    }
  } else if (key.ctrl && key.name === "n") {
    openSelector();
    return;
  } else if (key.ctrl && (key.name === "s" || key.name === "x")) {
    stopSession(sessions[active]);
  } else if (key.ctrl && key.name === "r") {
    rerunSession(active);
  } else if (key.ctrl && key.name === "a") {
    runActiveAction(active);
    return;
  } else if (key.ctrl && key.name === "w") {
    closeSession(active);
    return;
  } else if (key.ctrl && key.name === "l") {
    if (sessions[active]) sessions[active].output = [];
  } else if ((key.ctrl && key.name === "q") || (key.ctrl && key.name === "c")) {
    shutdown();
    return;
  } else if (key.name === "pageup") {
    scroll += 10;
  } else if (key.name === "pagedown") {
    scroll = Math.max(0, scroll - 10);
  } else if (key.name === "up") {
    scroll += 1;
  } else if (key.name === "down") {
    scroll = Math.max(0, scroll - 1);
  } else if (key.name === "return") {
    sendInput();
    return;
  } else if (key.name === "backspace") {
    input = input.slice(0, -1);
  } else if (key.name === "escape") {
    input = "";
  } else if (str && !key.ctrl && !key.meta && visibleLength(str) === 1) {
    input += str;
  }

  render();
}

function shutdown() {
  quitRequested = true;
  stopAll();
  process.stdin.setRawMode(false);
  process.stdin.pause();
  clearScreen();
  process.stdout.write(colors.reset);
}

function main() {
  loadTools();

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?25l");

  process.stdin.on("keypress", (str, key) => {
    if (mode === "select") {
      handleSelectKey(str, key);
    } else if (mode === "action") {
      handleActionKey(str, key);
    } else {
      handleRunKey(str, key);
    }
  });

  process.stdout.on("resize", render);
  process.on("exit", () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l" + colors.reset);
  });
  process.on("SIGINT", shutdown);

  render();
}

try {
  main();
} catch (error) {
  process.stderr.write(`multiplexer: ${error.message}\n`);
  process.exit(1);
}
