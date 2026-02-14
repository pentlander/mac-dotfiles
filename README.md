# dotfiles

Managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Setup on a new machine

```bash
# Install Homebrew packages (includes stow)
brew bundle --file=~/dotfiles/Brewfile

# Symlink everything into ~
cd ~/dotfiles
stow .
```

## After editing

Files in `~/dotfiles/.config/` are symlinked directly into `~/.config/`, so edits in either location are reflected immediately.

## Adding new configs

1. Mirror the path relative to `$HOME` inside `~/dotfiles/`, e.g.:
   - `~/.config/nvim/init.lua` → `~/dotfiles/.config/nvim/init.lua`
2. Run `stow .` again from `~/dotfiles/`
