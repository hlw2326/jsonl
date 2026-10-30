import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })

for (const args of [[], ['--module', 'CommonJS', '--moduleResolution', 'Node', '--outDir', 'dist/cjs']]) {
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', ...args], { cwd: root, stdio: 'inherit' })
}

await mkdir(new URL('../dist/cjs/', import.meta.url), { recursive: true })
await writeFile(new URL('../dist/cjs/package.json', import.meta.url), '{"type":"commonjs"}\n')
