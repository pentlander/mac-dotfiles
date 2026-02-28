# Plan Mode Extension

Read-only exploration mode. When enabled, all writes are blocked except `.md` files.

## Usage

- `/plan` or `Ctrl+Alt+P` — toggle plan mode
- `--plan` flag — start in plan mode

## Behavior

**Blocked:**
- `write` / `edit` to non-`.md` files
- Destructive bash commands (rm, mv, git commit, etc.)

**Allowed:**
- `write` / `edit` to any `.md` file
- Read-only bash commands (cat, grep, git log, etc.)
- All read-only tools (read, find, ls, code_nav, etc.)

## Plan directory

Plans are written to `plans/` if it exists in the working directory, otherwise to a temp directory. The agent is told which directory to use.
