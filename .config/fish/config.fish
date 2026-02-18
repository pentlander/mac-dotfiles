if status is-interactive
    # Commands to run in interactive sessions can go here
    if test -d /opt/homebrew
        /opt/homebrew/bin/brew shellenv | source
    end
    source "$(brew --prefix)/share/google-cloud-sdk/path.fish.inc"
    zoxide init fish | source
    

    fish_add_path -g "$HOME/bin"
    fish_add_path -g "$HOME/.local/bin"
    fish_add_path -g "$HOME/go/bin"
    fish_add_path -g "$HOME/.raildev"


    set -gx EDITOR nvim
    set -gx TERM xterm-256color
    set -g fish_key_bindings fish_vi_key_bindings

    bind --mode insert \cn 'accept-autosuggestion'

    alias vim='nvim'
    alias pi='/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'
    alias gwip='git add -A; git ls-files --deleted -z | xargs -0 git rm; git commit --no-verify -m "--wip--"'
    alias gunwip='git log -n 1 | grep -q -c "\-\-wip\-\-" && git reset HEAD~1'
    alias gme='git log --author $(git config --get user.name)'

    abbr -a g 'git'
    abbr -a gsw 'git switch'
    abbr -a gst 'git status'
    abbr -a gsta 'git stash'
    abbr -a gb 'git branch'
    abbr -a grs 'git restore'
    abbr -a grb 'git rebase'
    abbr -a grbi 'git rebase --interactive'
    abbr -a grbc 'git rebase --continue'
    abbr -a grba 'git rebase --abort'
    abbr -a grbm 'git rebase master'
    abbr -a ga 'git add'
    abbr -a gaa 'git add --all'
    abbr -a gc 'git commit --verbose'
    abbr -a gca 'git commit --amend --verbose'
    abbr -a gcan 'git commit --amend --no-edit'
    abbr -a gcan! 'git commit --amend --no-edit --all'
    abbr -a gup 'git pull --rebase origin master'
    abbr -a gd 'git diff'
    abbr -a gdh 'git diff HEAD~1'
    abbr -a glg 'git log --stat --max-count 10'
    abbr -a grhh 'git reset --hard HEAD'

    abbr -a j 'jj'
    abbr -a jn 'jj new'
    abbr -a jd 'jj diff'
    abbr -a jds 'jj describe -m'
    abbr -a je 'jj edit'
    abbr -a jl 'jj log'
    abbr -a jlt 'jj log -r "trunk()..@"'
    abbr -a js 'jj squash'
    abbr -a jsi 'jj split'
    abbr -a jab 'jj absorb'
    abbr -a jgf 'jj git fetch'
    abbr -a jgp 'jj git push'
    abbr -a jrb 'jj rebase'
    abbr -a ju 'jj undo'
    abbr -a jst 'jj status'
    abbr -a jbs --set-cursor "jj bookmark set '%' -r @"

    abbr -a st 'stacked'
    abbr -a stca --set-cursor "stacked create -a '%'"
    abbr -a stsn "stacked sync"
    abbr -a stsb "stacked submit"

    abbr -a tf 'terraform'
end
