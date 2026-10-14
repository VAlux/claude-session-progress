// What a Bash command wrote, as far as its text tells: the files it names, and what changed files it cannot name.

/** The files a command names as written, absolute where the session's directory is known; and, per command that changed files it does not name, a short label (`git merge`, `python3`). */
export type ShellWrites = { paths: string[]; unnamed: string[] }

/** A word of the command: its text with quotes taken off, and whether the shell computes part of it (`$x`, a glob, a backtick). */
type Word = { text: string; isDynamic: boolean }

/** One simple command: its words, the files it redirects output to, and the heredocs fed to it. */
type Segment = { words: Word[]; outputs: Word[]; bodies: string[] }

const INTERPRETERS = /^(python[\d.]*|node|bun|deno|ruby|tsx|ts-node)$/
const INLINE_FLAGS = new Set(['-c', '-e', '--eval', '-p', '--print'])
/** git subcommands that rewrite the working tree without naming its files. */
const GIT_REWRITES = new Set(['merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'am', 'apply', 'clean'])
const WRAPPERS = new Set(['sudo', 'env', 'time', 'command', 'nohup', 'npx', 'pnpx', 'bunx'])
const XARGS_VALUES = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s'])
/** Formatters whose `-w` writes the files back. */
const WRITES_WITH_W = new Set(['gofmt', 'goimports', 'gofumpt', 'shfmt'])
const SEPARATORS = ['&&', '||', ';', '|', '&', '\n', '(', ')']

/** Splits a command into simple commands, quotes resolved and heredoc bodies attached to the command that reads them. */
function segments(command: string): Segment[] {
  const out: Segment[] = []
  let seg: Segment = { words: [], outputs: [], bodies: [] }
  let word: Word | null = null
  /** Where the next word goes: a word, an output file, a heredoc's delimiter, or nowhere (an input file, a descriptor). */
  let into: 'word' | 'output' | 'heredoc' | 'body' | 'skip' = 'word'
  const heredocs: { tag: string; seg: Segment }[] = []

  const endWord = () => {
    if (word === null) return
    if (into === 'output') seg.outputs.push(word)
    else if (into === 'heredoc') heredocs.push({ tag: word.text, seg })
    else if (into === 'body') seg.bodies.push(word.text)
    else if (into === 'word') seg.words.push(word)
    word = null
    into = 'word'
  }
  const endSegment = () => {
    endWord()
    if (seg.words.length > 0 || seg.outputs.length > 0) out.push(seg)
    seg = { words: [], outputs: [], bodies: [] }
  }
  const append = (text: string, isDynamic = false) => {
    word = word === null ? { text, isDynamic } : { text: word.text + text, isDynamic: word.isDynamic || isDynamic }
  }

  let i = 0
  while (i < command.length) {
    const c = command[i] as string
    if (c === '#' && word === null) {
      // A comment runs to the end of its line.
      const eol = command.indexOf('\n', i)
      i = eol === -1 ? command.length : eol
      continue
    }
    if (c === '\\') {
      if (command[i + 1] !== '\n') append(command[i + 1] ?? '')
      i += 2
      continue
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      append(command.slice(i + 1, stop))
      i = stop + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      let text = ''
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) j += 1
        text += command[j]
        j += 1
      }
      append(text, /[$`]/.test(text))
      i = j + 1
      continue
    }
    if (c === '$' && command[i + 1] === '(') {
      let depth = 0
      let j = i + 1
      for (; j < command.length; j++) {
        if (command[j] === '(') depth += 1
        else if (command[j] === ')' && --depth === 0) break
      }
      append(command.slice(i, j + 1), true)
      i = j + 1
      continue
    }
    if (c === '`') {
      const end = command.indexOf('`', i + 1)
      const stop = end === -1 ? command.length : end
      append(command.slice(i, stop + 1), true)
      i = stop + 1
      continue
    }
    if (c === '\n') {
      endSegment()
      // Heredoc bodies start on the line after their command, in the order they were opened.
      let at = i + 1
      for (const doc of heredocs.splice(0)) {
        const lines: string[] = []
        while (at < command.length) {
          const eol = command.indexOf('\n', at)
          const line = command.slice(at, eol === -1 ? command.length : eol)
          at = eol === -1 ? command.length : eol + 1
          if (line.trim() === doc.tag) break
          lines.push(line)
        }
        doc.seg.bodies.push(lines.join('\n'))
      }
      i = at
      continue
    }
    if (c === '<') {
      endWord()
      if (command.startsWith('<<<', i)) {
        into = 'body'
        i += 3
      } else if (command.startsWith('<<', i)) {
        into = 'heredoc'
        i += command[i + 2] === '-' ? 3 : 2
      } else {
        into = 'skip'
        i += 1
      }
      continue
    }
    if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      // `2>` and `&>`: a descriptor number before `>` is no word.
      if (word !== null && /^\d+$/.test((word as Word).text)) word = null
      endWord()
      let j = c === '&' ? i + 2 : i + 1
      if (command[j] === '>' || command[j] === '|') j += 1
      if (command[j] === '&') {
        // `>&2`, `2>&1`: a descriptor, not a file.
        into = 'skip'
        j += 1
      } else {
        into = 'output'
      }
      i = j
      continue
    }
    const sep = SEPARATORS.find(s => command.startsWith(s, i))
    if (sep !== undefined && sep !== '\n') {
      endSegment()
      i += sep.length
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      i += 1
      continue
    }
    append(c, c === '*' || c === '?')
    i += 1
  }
  endSegment()
  return out
}

/** `/a/b/../c` → `/a/c`; a relative path joins `dir` when there is one. */
function resolve(dir: string | null, path: string): string {
  if (path.startsWith('~')) return path
  const joined = path.startsWith('/') || dir === null ? path : `${dir}/${path}`
  const isAbsolute = joined.startsWith('/')
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
    else parts.push(part)
  }
  const out = parts.join('/')
  return isAbsolute ? `/${out}` : out === '' ? '.' : out
}

/** The words after the command that are not options; `takesValue` names the options that eat the next word. */
function operands(args: Word[], takesValue: ReadonlySet<string> = new Set()): Word[] {
  const out: Word[] = []
  let isOptionsDone = false
  for (let i = 0; i < args.length; i++) {
    const text = (args[i] as Word).text
    if (!isOptionsDone && text === '--') isOptionsDone = true
    else if (!isOptionsDone && text.startsWith('-') && text !== '-') {
      if (takesValue.has(text)) i += 1
    } else out.push(args[i] as Word)
  }
  return out
}

/** The literal paths a script writes, and whether it also writes one it computes. */
function scriptWrites(script: string): { paths: string[]; isUnnamed: boolean } {
  const paths: string[] = []
  let isUnnamed = false
  const str = `(?:r|b)?['"\`]([^'"\`\\n]+)['"\`]`
  // Python: a Path kept in a variable, then written through it.
  const assigned = new Map<string, string[]>()
  const events: { at: number; kind: 'assign' | 'write'; name: string; path?: string }[] = []
  for (const m of script.matchAll(new RegExp(`\\b(\\w+)\\s*=\\s*(?:pathlib\\.)?Path\\(\\s*${str}\\s*\\)`, 'g')))
    events.push({ at: m.index ?? 0, kind: 'assign', name: m[1] as string, path: m[2] as string })
  for (const m of script.matchAll(/\b(\w+)\.(?:write_text|write_bytes)\(/g)) events.push({ at: m.index ?? 0, kind: 'write', name: m[1] as string })
  for (const ev of events.sort((a, b) => a.at - b.at)) {
    if (ev.kind === 'assign') assigned.set(ev.name, [ev.path as string])
    else {
      const known = assigned.get(ev.name)
      if (known === undefined) isUnnamed = true
      else paths.push(...known)
    }
  }
  // A Path written where it is made, a file opened to write, and Node's and Ruby's writes.
  for (const m of script.matchAll(new RegExp(`Path\\(\\s*${str}\\s*\\)\\s*\\.(?:write_text|write_bytes)\\(`, 'g'))) paths.push(m[1] as string)
  for (const m of script.matchAll(new RegExp(`\\bopen\\(\\s*${str}\\s*,\\s*(?:mode\\s*=\\s*)?['"]([^'"]*)['"]`, 'g')))
    if (/[wax+]/.test(m[2] as string)) paths.push(m[1] as string)
  for (const m of script.matchAll(/\bopen\(\s*[^'"`\s,)][^,)]*,\s*(?:mode\s*=\s*)?['"]([^'"]*)['"]/g)) if (/[wax+]/.test(m[1] as string)) isUnnamed = true
  for (const m of script.matchAll(new RegExp(`\\b(?:writeFileSync|writeFile|appendFileSync|appendFile|File\\.write)\\(\\s*${str}`, 'g'))) paths.push(m[1] as string)
  if (/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|File\.write)\(\s*[^'"`\s]/.test(script)) isUnnamed = true
  if (/\b(?:shutil\.(?:copy\w*|move|rmtree)|os\.(?:remove|unlink|rename|replace)|unlinkSync|renameSync|rmSync)\(/.test(script)) isUnnamed = true
  return { paths: [...new Set(paths)], isUnnamed }
}

const optionIn = (args: Word[], ...flags: string[]) => args.some(a => flags.includes(a.text))

/** What one Bash command wrote, as far as its text tells; relative paths resolve against `cwd` (and any `cd` in the command). */
export function shellWrites(command: string, cwd: string | null): ShellWrites {
  const paths: string[] = []
  const unnamed: string[] = []
  let dir = cwd
  const name = (w: Word, label: string) => {
    if (w.isDynamic || w.text === '' || w.text.includes('{}')) unnamed.push(label)
    else if (!w.text.startsWith('/dev/')) paths.push(resolve(dir, w.text))
  }

  for (const seg of segments(command)) {
    for (const out of seg.outputs) name(out, '>')
    let words = seg.words
    while (words.length > 0 && (/^\w+=/.test((words[0] as Word).text) || WRAPPERS.has((words[0] as Word).text))) words = words.slice(1)
    if (words.length === 0) continue
    const isXargs = (words[0] as Word).text === 'xargs'
    if (isXargs) {
      words = words.slice(1)
      while (words[0]?.text.startsWith('-') === true) words = words.slice(XARGS_VALUES.has((words[0] as Word).text) ? 2 : 1)
    }
    const head = words[0]
    if (head === undefined) continue
    const cmd = head.text.split('/').pop() ?? head.text
    const args = words.slice(1)
    /** Files a command names; under xargs they come from its input, so none can be named. */
    const named = (files: Word[], label: string) => {
      if (isXargs) unnamed.push(`xargs ${cmd}`)
      else for (const f of files) name(f, label)
    }

    if (cmd === 'cd') {
      const to = args[0]
      if (to === undefined || to.isDynamic) dir = null
      else dir = to.text.startsWith('/') ? resolve(null, to.text) : dir === null ? null : resolve(dir, to.text)
    } else if (cmd === 'tee') {
      named(operands(args), 'tee')
    } else if (cmd === 'sed') {
      const inPlace = args.findIndex(a => a.text.startsWith('-i') || a.text.startsWith('--in-place') || /^-[a-zA-Z]+i$/.test(a.text))
      if (inPlace === -1) continue
      // macOS takes the backup suffix as its own word: `sed -i '' ...`.
      const rest = args[inPlace]?.text === '-i' && args[inPlace + 1]?.text === '' ? [...args.slice(0, inPlace + 1), ...args.slice(inPlace + 2)] : args
      const files = operands(rest, new Set(['-e', '-f', '--expression', '--file']))
      named(optionIn(rest, '-e', '-f', '--expression', '--file') ? files : files.slice(1), 'sed')
    } else if (cmd === 'perl') {
      if (!args.some(a => /^-[a-zA-Z]*i/.test(a.text))) {
        const inline = args.findIndex(a => a.text === '-e' || a.text === '-E')
        if (inline !== -1 && scriptWrites(args[inline + 1]?.text ?? '').isUnnamed) unnamed.push('perl')
        continue
      }
      const files = operands(args, new Set(['-e', '-E']))
      named(optionIn(args, '-e', '-E') || args.some(a => /^-[a-zA-Z]*e$/.test(a.text)) ? files : files.slice(1), 'perl')
    } else if (['rm', 'touch', 'unlink', 'shred', 'truncate'].includes(cmd)) {
      named(operands(args, new Set(['-s', '--size'])), cmd)
    } else if (cmd === 'mv') {
      named(operands(args, new Set(['-t', '-S'])), 'mv')
    } else if (cmd === 'cp' || cmd === 'install' || cmd === 'ln') {
      const files = operands(args, new Set(['-t', '-S', '-m', '-o', '-g']))
      named(files.slice(-1), cmd)
    } else if (cmd === 'dd') {
      for (const a of args) if (a.text.startsWith('of=')) name({ ...a, text: a.text.slice(3) }, 'dd')
    } else if (cmd === 'git') {
      const rest = [...args]
      while (rest.length > 0 && (rest[0] as Word).text.startsWith('-')) rest.splice(0, ['-C', '-c'].includes((rest[0] as Word).text) ? 2 : 1)
      const sub = rest[0]?.text
      const subArgs = rest.slice(1)
      if (sub === undefined) continue
      if (sub === 'mv' || sub === 'rm') named(operands(subArgs), `git ${sub}`)
      else if (sub === 'restore') named(operands(subArgs, new Set(['-s', '--source'])), 'git restore')
      else if (sub === 'checkout' || sub === 'switch') {
        const dashes = subArgs.findIndex(a => a.text === '--')
        if (dashes !== -1) named(subArgs.slice(dashes + 1), `git ${sub}`)
        else if (!optionIn(subArgs, '-b', '-B', '-c', '-C', '--orphan') && subArgs.length > 0) unnamed.push(`git ${sub}`)
      } else if (sub === 'reset') {
        if (optionIn(subArgs, '--hard', '--merge', '--keep')) unnamed.push('git reset')
      } else if (sub === 'stash') {
        if (subArgs.length === 0 || ['push', 'save', 'pop', 'apply'].includes((subArgs[0] as Word).text)) unnamed.push('git stash')
      } else if (GIT_REWRITES.has(sub)) unnamed.push(`git ${sub}`)
    } else if (cmd === 'find') {
      const exec = args.findIndex(a => a.text === '-exec' || a.text === '-execdir')
      const run = exec === -1 ? undefined : args[exec + 1]?.text
      if (optionIn(args, '-delete') || (run !== undefined && ['sed', 'perl', 'rm', 'mv', 'cp', 'tee', 'truncate'].includes(run))) unnamed.push('find')
    } else if (cmd === 'patch') {
      unnamed.push('patch')
    } else if (INTERPRETERS.test(cmd)) {
      const inline = args.findIndex(a => INLINE_FLAGS.has(a.text))
      const scripts = [...seg.bodies, ...(inline === -1 ? [] : [args[inline + 1]?.text ?? ''])]
      for (const script of scripts) {
        const wrote = scriptWrites(script)
        for (const p of wrote.paths) paths.push(resolve(dir, p))
        if (wrote.isUnnamed) unnamed.push(cmd)
      }
    } else if (optionIn(args, '--fix', '--write') || (WRITES_WITH_W.has(cmd) && optionIn(args, '-w'))) {
      // A formatter or linter fixing files in place: prettier --write, eslint --fix, gofmt -w.
      unnamed.push(cmd)
    }
  }
  return { paths: [...new Set(paths)], unnamed: [...new Set(unnamed)] }
}
