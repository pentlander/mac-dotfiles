function fish_vcs_prompt --description 'Print all vcs prompts, preferring jj'
    fish_jj_prompt $argv
    or fish_git_prompt $argv
    or fish_hg_prompt $argv
    or fish_fossil_prompt $argv
end
