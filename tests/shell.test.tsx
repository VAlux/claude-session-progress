import { expect, test } from 'claude-code/testing'

import { shellWrites } from '../hooks/shell'

const at = (command: string) => shellWrites(command, '/repo')

test('a redirect names its file, relative to the session directory', async () => {
  expect(at('echo hi > notes.txt')).toEqual({ paths: ['/repo/notes.txt'], unnamed: [] })
  expect(at('printf x >> /tmp/log.txt 2>&1')).toEqual({ paths: ['/tmp/log.txt'], unnamed: [] })
  expect(at('cat > src/a.ts <<\'EOF\'\nconst a = 1 > 0\nEOF')).toEqual({ paths: ['/repo/src/a.ts'], unnamed: [] })
})

test('reads, pipes and discarded output change nothing', async () => {
  for (const command of [
    'git status --short | head',
    'npm run typecheck 2>&1 | grep -c "error TS"',
    'ls > /dev/null 2>/dev/null',
    "grep -n 'a > b' src/x.ts",
    'sed -n 1,80p README.md',
    'git checkout -b feature',
    'git stash list',
    'npm ci',
  ]) {
    expect(at(command), command).toEqual({ paths: [], unnamed: [] })
  }
})

test('a redirect to a name the shell computes cannot be named', async () => {
  expect(at('echo x > "$OUT"')).toEqual({ paths: [], unnamed: ['>'] })
})

test('cd moves where relative paths resolve', async () => {
  expect(at('cd server && echo x > a.ts')).toEqual({ paths: ['/repo/server/a.ts'], unnamed: [] })
  expect(shellWrites('echo x > a.ts', null)).toEqual({ paths: ['a.ts'], unnamed: [] })
})

test('sed -i, perl -pi and tee name the files they write', async () => {
  expect(at("sed -i '' 's/a/b/' src/a.ts src/b.ts").paths).toEqual(['/repo/src/a.ts', '/repo/src/b.ts'])
  expect(at("sed -i.bak -e 's/a/b/' x.ts").paths).toEqual(['/repo/x.ts'])
  expect(at("perl -pi -e 's/a/b/' y.ts").paths).toEqual(['/repo/y.ts'])
  expect(at('npm test | tee out.log').paths).toEqual(['/repo/out.log'])
  expect(at("grep -l foo src | xargs sed -i 's/foo/bar/'")).toEqual({ paths: [], unnamed: ['xargs sed'] })
})

test('file commands name their files', async () => {
  expect(at('rm -f a.ts b.ts').paths).toEqual(['/repo/a.ts', '/repo/b.ts'])
  expect(at('mv old.ts new.ts').paths).toEqual(['/repo/old.ts', '/repo/new.ts'])
  expect(at('cp src.ts dst.ts').paths).toEqual(['/repo/dst.ts'])
  expect(at('git mv a.ts b.ts').paths).toEqual(['/repo/a.ts', '/repo/b.ts'])
  expect(at('git checkout -- a.ts').paths).toEqual(['/repo/a.ts'])
})

test('git commands that rewrite the tree, and formatters, change files they do not name', async () => {
  expect(at('git merge origin/main --no-edit 2>&1 | tail -15').unnamed).toEqual(['git merge'])
  expect(at('git checkout main').unnamed).toEqual(['git checkout'])
  expect(at('git stash pop').unnamed).toEqual(['git stash'])
  expect(at('git reset --hard HEAD~1').unnamed).toEqual(['git reset'])
  expect(at('git reset HEAD~1').unnamed).toEqual([])
  expect(at('npx prettier --write src').unnamed).toEqual(['prettier'])
  expect(at('npx eslint --fix .').unnamed).toEqual(['eslint'])
})

test('a Python script names the files it writes, through a variable too', async () => {
  const script = [
    "python3 - <<'EOF'",
    'import pathlib',
    "p=pathlib.Path('server/ops/http.ts'); s=p.read_text()",
    "s=s.replace('a > b','c')",
    'p.write_text(s)',
    "p=pathlib.Path('src/ops/api.ts'); s=p.read_text()",
    'p.write_text(s)',
    "pathlib.Path('docs/x.md').write_text('hi')",
    "open('out.json', 'w').write('{}')",
    "open('in.json').read()",
    'EOF',
  ].join('\n')
  expect(at(script)).toEqual({ paths: ['/repo/server/ops/http.ts', '/repo/src/ops/api.ts', '/repo/docs/x.md', '/repo/out.json'], unnamed: [] })
})

test('a script that writes a path it computes cannot name it', async () => {
  const script = ["python3 - <<'EOF'", 'def fix(path):', '    p=pathlib.Path(path); p.write_text("x")', "fix('a.ts')", 'EOF'].join('\n')
  expect(at(script)).toEqual({ paths: [], unnamed: ['python3'] })
  expect(at(`node -e "require('fs').writeFileSync('a.json', '{}')"`)).toEqual({ paths: ['/repo/a.json'], unnamed: [] })
  expect(at("python3 -c 'print(1)'")).toEqual({ paths: [], unnamed: [] })
})
