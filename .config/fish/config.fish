if test -e /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.fish
    . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.fish
end

if status is-interactive
    # Commands to run in interactive sessions can go here
    set -gx EDITOR nvim

    source "$HOME/.cargo/env.fish"

    bind --mode insert \cn 'accept-autosuggestion'

    alias vim='nvim'
    alias gwip='git add -A; git ls-files --deleted -z | xargs -0 git rm; git commit --no-verify -m "--wip--"'
    alias gunwip='git log -n 1 | grep -q -c "\-\-wip\-\-" && git reset HEAD~1'
    alias gme='git log --author $(git config --get user.name)'

    abbr -a -- g git
    abbr -a -- gco 'git checkout'
    abbr -a -- gst 'git status'
    abbr -a -- gb 'git branch'
    abbr -a -- grb 'git rebase'
    abbr -a -- grbi 'git rebase --interactive'
    abbr -a -- grbc 'git rebase --continue'
    abbr -a -- grba 'git rebase --abort'
    abbr -a -- grbm 'git rebase master'
    abbr -a -- ga 'git add'
    abbr -a -- gaa 'git add --all'
    abbr -a -- gc 'git commit'
    abbr -a -- gcan 'git commit --amend --no-edit'
    abbr -a -- gcan! 'git commit --amend --no-edit --all'
    abbr -a -- gup 'git pull --rebase origin master'
    abbr -a -- gd 'git diff'
    abbr -a -- gdh 'git diff HEAD~1'
    abbr -a -- glg 'git log --stat --max-count 10'
    abbr -a -- grhh 'git reset --hard HEAD'
end
