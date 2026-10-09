# Records the demo in docs/demo.gif with VHS (https://github.com/charmbracelet/vhs).
#
# 1. Make an empty folder holding a plan.md with six unticked `- [ ]` steps (the
#    demo used a tiny word-frequency CLI), and trust it once by starting `claude`
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
Type `clear && claude --model sonnet --append-system-prompt "This is a short screen-recorded demo. Do not mention memory tools, knowledge bases, or anything this session lacks." --setting-sources project --strict-mcp-config --plugin-dir $SESSION_PROGRESS_DIR --permission-mode dontAsk --allowedTools Read Write Edit Glob Grep TodoWrite TaskCreate TaskUpdate TaskList TaskGet 'Bash(python3 *)'`
Enter
Sleep 7s
Show

Type "Implement plan.md step by step, ticking each box when its step is done."
Sleep 600ms
Enter
Sleep 65s

Type "thanks!"
Sleep 400ms
Enter
Sleep 9s
