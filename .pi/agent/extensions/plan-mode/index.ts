/**
 * Plan Mode Extension
 *
 * Read-only exploration mode. When enabled:
 * - Only read-only tools available (no edit/write)
 * - Bash restricted to safe read-only commands
 * - Exception: .md files can always be written/edited
 *
 * Plans are written to plans/ if it exists, otherwise to a tmp dir.
 *
 * Toggle: /plan or Ctrl+Alt+P
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSafeCommand } from "./utils.js";

const PLAN_MODE_TOOLS = [
	"read", "bash", "write", "edit", "grep", "find", "ls",
	// Read-only extension tools
	"code_nav", "find_identifiers", "string_search", "jb_symbol", "jb_problems",
];

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let savedActiveTools: string[] | null = null;
	let planDir: string | null = null;

	function getPlanDir(): string {
		if (planDir) return planDir;
		const local = resolve("plans");
		if (existsSync(local)) {
			planDir = local;
		} else {
			planDir = join(tmpdir(), `pi-plans-${Date.now()}`);
		}
		return planDir;
	}

	function isMdPath(path: string): boolean {
		return path.endsWith(".md");
	}

	function togglePlanMode(ctx: { ui: { notify: (msg: string, kind?: string) => void } }): void {
		planModeEnabled = !planModeEnabled;

		if (planModeEnabled) {
			savedActiveTools = pi.getActiveTools();
			pi.setActiveTools(PLAN_MODE_TOOLS);
			const dir = getPlanDir();
			ctx.ui.notify(`Plan mode on. Writes restricted to .md files. Plan dir: ${dir}`);
		} else {
			pi.setActiveTools(savedActiveTools ?? pi.getActiveTools());
			savedActiveTools = null;
			ctx.ui.notify("Plan mode off. Full access restored.");
		}
		updateStatus(ctx);
	}

	function updateStatus(ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } }): void {
		ctx.ui.setStatus("plan-mode", planModeEnabled ? "⏸ plan" : undefined);
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only, .md files only)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block non-md writes and edits in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (event.toolName === "write" || event.toolName === "edit") {
			const path = event.input.path as string;
			if (!isMdPath(path)) {
				return {
					block: true,
					reason: `Plan mode: can only write .md files. Blocked: ${path}`,
				};
			}
			return;
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command blocked (not in allowlist). Use /plan to disable.\nCommand: ${command}`,
				};
			}
		}
	});

	// Inject plan mode context
	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return;

		const dir = getPlanDir();
		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- You can ONLY write/edit .md files (all other writes are blocked)
- Bash is restricted to read-only commands
- Write plans to: ${dir}

Explore the code, ask clarifying questions, and write your plan as markdown.`,
				display: false,
			},
		};
	});

	// Filter stale plan context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as typeof m & { customType?: string };
				return msg.customType !== "plan-mode-context";
			}),
		};
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
