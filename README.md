# dotfiles

Managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Fresh machine setup

```bash
# Install Xcode command line tools (needed for git, clang, etc.)
xcode-select --install

# Clone and run
git clone <repo-url> ~/dotfiles
cd ~/dotfiles
./setup.sh
```

The setup script will:

1. Install **Homebrew** (if missing) and all packages from `Brewfile`
2. **Stow** all config files into `~` as symlinks
3. Install **mise** runtimes (Node, Go, etc.)
4. Install **Rust** via rustup (if missing)
5. Install **pi** coding agent and its extension dependencies
6. Set **fish** as the default shell

## After editing

Files in `~/dotfiles/` are symlinked into `~`, so edits in either location are reflected immediately.

## Adding new configs

1. Mirror the path relative to `$HOME` inside `~/dotfiles/`, e.g.:
   - `~/.config/nvim/init.lua` → `~/dotfiles/.config/nvim/init.lua`
2. Run `stow .` from `~/dotfiles/`

## Updating Homebrew packages

```bash
# After installing/removing a brew package, regenerate the Brewfile:
brew bundle dump --file=~/dotfiles/Brewfile --force
```
