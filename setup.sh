#!/usr/bin/env bash
#
# Bootstrap a fresh macOS machine from this dotfiles repo.
#
# Usage:
#   git clone <repo> ~/dotfiles
#   cd ~/dotfiles
#   ./setup.sh
#
set -euo pipefail

DOTFILES="$(cd "$(dirname "$0")" && pwd)"
cd "$DOTFILES"

section() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

# ── Homebrew ────────────────────────────────────────────────────────────────
section "Homebrew"
if ! command -v brew &>/dev/null; then
    echo "Installing Homebrew…"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi
echo "Installing packages from Brewfile…"
brew bundle --file="$DOTFILES/Brewfile"

# ── Stow ────────────────────────────────────────────────────────────────────
section "Stow"
echo "Symlinking dotfiles into ~"
stow --adopt --restow .

# Restore any files --adopt may have pulled in from a dirty home dir
git checkout .

# ── mise (runtime manager) ──────────────────────────────────────────────────
section "mise"
if ! command -v mise &>/dev/null; then
    echo "mise was installed via Brewfile, activating…"
fi
eval "$(mise activate bash)"
echo "Installing runtimes (node, go, etc.)…"
mise install --yes

# ── Rust ────────────────────────────────────────────────────────────────────
section "Rust"
if ! command -v rustup &>/dev/null; then
    echo "Installing Rust via rustup…"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
else
    echo "Rust already installed: $(rustup show active-toolchain)"
fi

# ── pi (coding agent) ──────────────────────────────────────────────────────
section "pi"
if ! command -v pi &>/dev/null; then
    echo "Installing pi…"
    npm install -g @mariozechner/pi-coding-agent
else
    echo "pi already installed: $(pi --version 2>/dev/null || echo 'unknown version')"
fi

# ── pi extensions ───────────────────────────────────────────────────────────
section "pi extensions"
for ext_dir in "$HOME"/.pi/agent/extensions/*/; do
    if [ -f "$ext_dir/package.json" ]; then
        echo "Installing deps for $(basename "$ext_dir")…"
        (cd "$ext_dir" && npm install)
    fi
done

# ── Fish shell ──────────────────────────────────────────────────────────────
section "Fish shell"
FISH_PATH="/opt/homebrew/bin/fish"
if ! grep -qx "$FISH_PATH" /etc/shells 2>/dev/null; then
    echo "Adding fish to /etc/shells…"
    echo "$FISH_PATH" | sudo tee -a /etc/shells
fi
if [ "$SHELL" != "$FISH_PATH" ]; then
    echo "Setting fish as default shell…"
    chsh -s "$FISH_PATH"
else
    echo "Fish is already the default shell"
fi

# ── Done ────────────────────────────────────────────────────────────────────
section "Done!"
echo "All set. Open a new terminal (Ghostty) to start using your setup."
echo ""
echo "Remaining manual steps:"
echo "  • Run 'pi' and authenticate with your provider"
echo "  • Sign into any apps installed via Homebrew casks"
