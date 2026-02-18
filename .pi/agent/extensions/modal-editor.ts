/**
 * Modal Editor - vim-like modal editing
 *
 * Modes:
 *   Insert (default) — normal text editing
 *   Normal — vim-style navigation and commands
 *
 * Normal mode keys:
 *   i       — insert mode at cursor
 *   a       — insert mode after cursor (append)
 *   A       — insert mode at end of line
 *   I       — insert mode at start of line
 *   o       — open new line below, enter insert mode
 *   O       — open new line above, enter insert mode
 *   h/j/k/l — cursor movement
 *   w       — forward to start of next word
 *   b       — backward to start of previous word
 *   e       — forward to end of current/next word
 *   0       — line start
 *   $       — line end
 *   x       — delete character under cursor
 *   C       — delete to end of line, enter insert mode
 *   cc      — clear line, enter insert mode
 *   cw/ce   — delete word forward, enter insert mode
 *   cb      — delete word backward, enter insert mode
 *   dd      — delete current line
 *   dw/de   — delete word forward
 *   db      — delete word backward
 *   u       — undo
 *   v       — open prompt in $EDITOR (nvim)
 *   Escape  — pass through to app (abort agent, etc.)
 *
 *   ctrl+c, ctrl+d, etc. work in both modes
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI, type EditorTheme } from "@mariozechner/pi-tui";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Terminal escape sequences
const ESC = {
  left: "\x1b[D",
  right: "\x1b[C",
  up: "\x1b[A",
  down: "\x1b[B",
  delete: "\x1b[3~",
  home: "\x01",      // ctrl+a
  end: "\x05",       // ctrl+e
  wordLeft: "\x1bb",  // alt+b
  wordRight: "\x1bf", // alt+f
  enter: "\x1b[13;2~", // shift+enter (newline without submit)
  backspace: "\x7f",
  deleteToEnd: "\x0b",   // ctrl+k
  deleteToStart: "\x15", // ctrl+u
};

class ModalEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";
  private pendingKey: string | null = null; // for multi-key commands like dd
  private tui: TUI;

  constructor(tui: TUI, theme: EditorTheme, kb: KeybindingsManager) {
    super(tui, theme, kb);
    this.tui = tui;
  }

  handleInput(data: string): void {
    // Escape toggles to normal mode, or passes through for app handling
    if (matchesKey(data, "escape")) {
      if (this.mode === "insert") {
        this.mode = "normal";
        this.pendingKey = null;
      } else {
        super.handleInput(data);
      }
      return;
    }

    // Insert mode: pass everything through
    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }

    // ── Normal mode ──

    // Handle multi-key sequences (dd, cc)
    if (this.pendingKey === "d") {
      this.pendingKey = null;
      if (data === "d") {
        this.deleteCurrentLine();
        return;
      }
      if (data === "w") {
        // dw: delete word forward (includes trailing whitespace)
        this.deleteWordForward(true);
        return;
      }
      if (data === "e") {
        // de: delete to end of word
        this.deleteWordForward(false);
        return;
      }
      if (data === "b") {
        // db: delete word backward
        this.deleteWordBackward();
        return;
      }
      return;
    }
    if (this.pendingKey === "c") {
      this.pendingKey = null;
      if (data === "c") {
        // cc: clear line contents, stay on the line in insert mode
        super.handleInput(ESC.home);
        super.handleInput(ESC.deleteToEnd);
        this.mode = "insert";
        return;
      }
      if (data === "w" || data === "e") {
        // cw/ce: delete to end of word, enter insert mode
        this.deleteWordForward(false);
        this.mode = "insert";
        return;
      }
      if (data === "b") {
        // cb: delete word backward, enter insert mode
        this.deleteWordBackward();
        this.mode = "insert";
        return;
      }
      return;
    }

    // Single-key normal mode commands
    switch (data) {
      // Mode switches
      case "i":
        this.mode = "insert";
        return;
      case "a":
        this.mode = "insert";
        super.handleInput(ESC.right);
        return;
      case "A":
        this.mode = "insert";
        super.handleInput(ESC.end);
        return;
      case "I":
        this.mode = "insert";
        super.handleInput(ESC.home);
        return;
      case "o":
        super.handleInput(ESC.end);
        super.handleInput(ESC.enter);
        this.mode = "insert";
        return;
      case "O":
        super.handleInput(ESC.home);
        super.handleInput(ESC.enter);
        super.handleInput(ESC.up);
        this.mode = "insert";
        return;

      // Navigation
      case "h":
        super.handleInput(ESC.left);
        return;
      case "j":
        super.handleInput(ESC.down);
        return;
      case "k":
        super.handleInput(ESC.up);
        return;
      case "l":
        super.handleInput(ESC.right);
        return;
      case "w":
        super.handleInput(ESC.wordRight);
        return;
      case "b":
        super.handleInput(ESC.wordLeft);
        return;
      case "e":
        // Move to end of word: word-right then back one
        // (word-right lands at the start of the next word)
        super.handleInput(ESC.wordRight);
        super.handleInput(ESC.left);
        return;
      case "0":
        super.handleInput(ESC.home);
        return;
      case "$":
        super.handleInput(ESC.end);
        return;

      // Editing
      case "x":
        super.handleInput(ESC.delete);
        return;
      case "d":
        this.pendingKey = "d";
        return;
      case "c":
        this.pendingKey = "c";
        return;
      case "C":
        // Delete from cursor to end of line, enter insert mode
        super.handleInput(ESC.deleteToEnd);
        this.mode = "insert";
        return;

      // Undo
      case "u":
        super.handleInput("\x1f"); // ctrl+- = undo
        return;

      // External editor
      case "v":
        this.openInExternalEditor();
        return;

      default:
        // Pass control sequences (ctrl+c, etc.) to super, ignore printable chars
        if (data.length === 1 && data.charCodeAt(0) >= 32) return;
        super.handleInput(data);
        return;
    }
  }

  private deleteWordForward(includeTrailingSpace: boolean): void {
    const lines = this.getLines();
    const { line, col } = this.getCursor();
    const text = lines[line] || "";

    if (col >= text.length) return;

    let end = col;
    if (/\s/.test(text[end]!)) {
      // On whitespace: skip whitespace, then skip word
      while (end < text.length && /\s/.test(text[end]!)) end++;
      while (end < text.length && !/\s/.test(text[end]!)) end++;
    } else {
      // In a word: skip to end of word
      while (end < text.length && !/\s/.test(text[end]!)) end++;
      // dw also consumes trailing whitespace
      if (includeTrailingSpace) {
        while (end < text.length && /\s/.test(text[end]!)) end++;
      }
    }

    lines[line] = text.slice(0, col) + text.slice(end);
    this.setText(lines.join("\n"));
    this.moveCursorTo(line, col, lines.length);
  }

  private deleteWordBackward(): void {
    const lines = this.getLines();
    const { line, col } = this.getCursor();
    const text = lines[line] || "";

    if (col <= 0) return;

    let start = col;
    // Skip whitespace backwards
    while (start > 0 && /\s/.test(text[start - 1]!)) start--;
    // Skip word characters backwards
    while (start > 0 && !/\s/.test(text[start - 1]!)) start--;

    lines[line] = text.slice(0, start) + text.slice(col);
    this.setText(lines.join("\n"));
    this.moveCursorTo(line, start, lines.length);
  }

  /** Reposition cursor after setText (which places cursor at end of last line) */
  private moveCursorTo(targetLine: number, targetCol: number, totalLines: number): void {
    const lastLine = totalLines - 1;
    // After setText, cursor is at (lastLine, endOfLastLine)
    super.handleInput(ESC.home); // go to col 0
    for (let i = 0; i < lastLine - targetLine; i++) {
      super.handleInput(ESC.up);
    }
    for (let i = 0; i < targetCol; i++) {
      super.handleInput(ESC.right);
    }
  }

  private deleteCurrentLine(): void {
    const lines = this.getLines();
    const cursor = this.getCursor();

    if (lines.length <= 1) {
      // Only one line — just clear it
      this.setText("");
      return;
    }

    lines.splice(cursor.line, 1);
    this.setText(lines.join("\n"));

    // Restore cursor to same line (or last line if we deleted the last one)
    const targetLine = Math.min(cursor.line, lines.length - 1);
    this.moveCursorTo(targetLine, 0, lines.length);
  }

  private openInExternalEditor(): void {
    const text = this.getExpandedText();
    const tmpFile = join(tmpdir(), `pi-editor-${Date.now()}.md`);

    try {
      writeFileSync(tmpFile, text);

      // Stop TUI to give terminal to the external editor
      this.tui.stop();

      const editor = process.env.EDITOR || "nvim";
      const result = spawnSync(editor, [tmpFile], {
        stdio: "inherit",
      });

      // Restart TUI
      this.tui.start();

      if (result.status === 0) {
        const newText = readFileSync(tmpFile, "utf-8");
        this.setText(newText.replace(/\n$/, "")); // strip trailing newline editors add
      }
    } catch {
      // If anything goes wrong, make sure TUI is restarted
      try { this.tui.start(); } catch {}
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;

    // Add mode indicator to bottom border
    const label = this.mode === "normal"
      ? (this.pendingKey ? ` NORMAL (${this.pendingKey}) ` : " NORMAL ")
      : " INSERT ";
    const last = lines.length - 1;
    if (visibleWidth(lines[last]!) >= label.length) {
      lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
  });
}
