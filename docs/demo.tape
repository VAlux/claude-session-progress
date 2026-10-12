# Records the demo in docs/demo.gif with VHS (https://github.com/charmbracelet/vhs).
#
# 1. Make an empty folder holding a plan.md with six unticked `- [ ]` steps (the
#    demo used a tiny word-frequency CLI, with a last step that runs
#    `python3 wordfreq.py nope.txt`, so one call fails on screen), and trust it once by starting `claude`
#    there yourself: the trust dialog defaults to "No, exit".
# 2. Point SESSION_PROGRESS_DIR at this repository, then from that folder:
#      vhs /path/to/repo/docs/demo.tape
# 3. Convert the video:
#      ffmpeg -i raw.mp4 -vf "fps=10,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" demo-full.gif
#      gifsicle -O3 --lossy=60 demo-full.gif -o demo.gif
#
# The session runs with your own settings, other plugins and MCP servers off, so only
# this mod draws. Your own CLAUDE.md still loads (--safe-mode would skip it, but it
# also skips --plugin-dir mods), so the appended prompt keeps it off screen.
# `dontAsk` refuses any tool not listed instead of prompting, so a permission
# dialog can never stall the recording. The pauses are fixed because
# `Wait+Screen` reads the top of the terminal's buffer and never sees the band once
# the transcript scrolls.

Output raw.mp4
Set Shell zsh
Set FontSize 15
Set Width 1440
Set Height 860
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type "unset $(env | cut -d= -f1 | grep -E '^CLAUDE')"
Enter
Type `clear && claude --model sonnet --append-system-prompt "This is a short screen-recorded demo. Do not mention memory tools, knowledge bases, or anything this session lacks. Run each shell command as its own plain python3 call in the current directory: no cd, no pipes, no ;, && or 2>&1." --setting-sources project --strict-mcp-config --plugin-dir $SESSION_PROGRESS_DIR --permission-mode dontAsk --allowedTools Read Write Edit Glob Grep TodoWrite TaskCreate TaskUpdate TaskList TaskGet ToolSearch 'Bash(python3 *)'`
Enter
Sleep 7s
Show

# Turn 1: the live band. Open the tool calls, then the files, with the keyboard
# (VHS has no mouse): ctrl+x tab focuses the band, tab moves between counts.
Type "Implement plan.md step by step, ticking each box when its step is done."
Sleep 600ms
Enter
Sleep 7s
Ctrl+X
Tab
Sleep 500ms
Enter
Sleep 5s
Tab
Sleep 500ms
Enter
Sleep 5s
Sleep 14s

# The summary: files, then the failed calls.
Ctrl+X
Tab
Sleep 500ms
Tab
Sleep 500ms
Enter
Sleep 5s
Tab
Tab
Tab
Tab
Sleep 500ms
Enter
Sleep 6s
Screenshot mid.png

# Turn 2: the summary now carries the session total and its cost.
Escape
Sleep 500ms
Type "Now add three options: --min-length N to skip short words, --ignore FILE to skip the words listed in it, and --json for JSON output. Keep a task list, give each its own test, run the tests, and document them in README.md."
Sleep 600ms
Enter
Sleep 50s
Screenshot end.png
Sleep 8s
