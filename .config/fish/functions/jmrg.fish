function jmrg -d "Merge PR on GitHub, clean up bookmark, fetch and rebase" -a rev
    set -q rev[1]; or set rev @

    set -l branch (jj bookmark list -r "$rev" -T 'if(name.starts_with("push-"), name ++ "\n")' | head -1)
    if test -z "$branch"
        echo "No push-* bookmark found on $rev"
        return 1
    end

    set -l repo (jj git remote list | string match -rg '^origin\s+.*github\.com[:/](.*?)(?:\.git)?$')

    echo "Merging PR for $branch..."
    gh pr merge $branch --squash --repo $repo
    or return 1

    echo "Cleaning up..."
    jj bookmark delete $branch
    jj git fetch -b main -b master
    jj rebase -d 'trunk()' --skip-emptied
end
