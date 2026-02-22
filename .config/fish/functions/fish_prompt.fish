function fish_prompt --description 'Write out the prompt'
    set -l last_pipestatus $pipestatus
    set -lx __fish_last_status $status
    set -l normal (set_color normal)
    set -q fish_color_status
    or set -g fish_color_status red

    set -l color_cwd $fish_color_cwd
    set -l suffix '>'
    if functions -q fish_is_root_user; and fish_is_root_user
        if set -q fish_color_cwd_root
            set color_cwd $fish_color_cwd_root
        end
        set suffix '#'
    end

    set -l bold_flag --bold
    set -q __fish_prompt_status_generation; or set -g __fish_prompt_status_generation $status_generation
    if test $__fish_prompt_status_generation = $status_generation
        set bold_flag
    end
    set __fish_prompt_status_generation $status_generation
    set -l status_color (set_color $fish_color_status)
    set -l statusb_color (set_color $bold_flag $fish_color_status)
    set -l prompt_status (__fish_print_pipestatus "[" "]" "|" "$status_color" "$statusb_color" $last_pipestatus)

    # VCS prompt: prefer jj over git
    set -l vcs_info
    if command -q jj
        set vcs_info (__jj_prompt)
    end
    if test -z "$vcs_info"
        set vcs_info (fish_vcs_prompt)
    end

    echo -n -s (prompt_login)' ' (set_color $color_cwd) (prompt_pwd) $normal $vcs_info $normal " "$prompt_status $suffix " "
end

function __jj_prompt
    jj root --ignore-working-copy &>/dev/null; or return

    # Get change ID and bookmarks in one call
    set -l info (jj log -r '@' --no-graph --ignore-working-copy -T 'separate("\n", change_id.shortest(4), bookmarks.map(|b| b.name()).join(", "))' 2>/dev/null)
    or return

    set -l change_id $info[1]
    set -l bookmarks $info[2]

    set -l result " "(set_color magenta)"$change_id"(set_color normal)
    if test -n "$bookmarks"
        set result "$result "(set_color cyan)"$bookmarks"(set_color normal)
    end
    echo -n $result
end
