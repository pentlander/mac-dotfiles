function jpr -d "Push current change, create or update GitHub PR"
    jj git push --change @ 2>&1 | string match -v 'remote:*'
    test $pipestatus[1] -ne 0; and return 1

    set -l repo (jj git remote list | string match -rg '^origin\s+.*github\.com[:/](.*?)(?:\.git)?$')
    set -l branch push-(jj log --no-graph -r @ -T 'change_id.short()')
    set -l title "$(jj log --no-graph -r @ -T 'description.first_line()')"
    set -l body "$(jj log --no-graph -r @ -T 'description.remove_prefix(description.first_line()).trim()')"

    # Check if PR already exists
    set -l pr_url (gh pr list --head $branch --repo $repo --json url --jq '.[0].url' 2>/dev/null)

    if test -n "$pr_url"
        set -l old_title "$(gh pr view "$pr_url" --repo $repo --json title --jq '.title')"
        set -l old_body "$(gh pr view "$pr_url" --repo $repo --json body --jq '.body')"

        if test "$old_title" != "$title" -o "$old_body" != "$body"
            echo "Updating PR title/body..."
            gh pr edit "$pr_url" --title "$title" --body "$body" --repo $repo
        else
            echo "PR up to date: $pr_url"
        end
    else
        echo "Creating PR..."
        gh pr create --title "$title" --body "$body" --head $branch --repo $repo
    end
end
