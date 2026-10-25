import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const [repositoryInput, workerUrlInput] = process.argv.slice(2)

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseRepository(input) {
  if (!input) return null
  const value = input.trim().replace(/\/+$/, '')
  const match = value.match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/)
  return match ? `${match[1]}/${match[2]}` : null
}

function parseEnv(contents) {
  const values = new Map()
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || match[1].startsWith('#')) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values.set(match[1], value)
  }
  return values
}

const repository = parseRepository(repositoryInput)
if (!repository) fail('Usage: npm run github:variables -- <owner/repo> <https-worker-url>')

let workerUrl
try {
  workerUrl = new URL(workerUrlInput)
  if (workerUrl.protocol !== 'https:' || workerUrl.username || workerUrl.password || workerUrl.search || workerUrl.hash) {
    fail('Worker URL must be HTTPS and must not contain credentials, query parameters, or a fragment.')
  }
  workerUrl.pathname = workerUrl.pathname.replace(/\/+$/, '')
} catch {
  fail('Provide a valid HTTPS Worker URL.')
}

let envContents
try {
  envContents = await readFile(new URL('../.env', import.meta.url), 'utf8')
} catch {
  fail('Cannot read .env. Create it from .env.example and fill in the Firebase web configuration.')
}

const env = parseEnv(envContents)
const requiredNames = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
]
const variables = requiredNames.map((name) => [name, env.get(name)])
variables.push(['VITE_API_BASE_URL', workerUrl.origin + workerUrl.pathname])

const missing = variables
  .filter(([, value]) => !value || value.startsWith('your-'))
  .map(([name]) => name)
if (missing.length) fail(`Missing or placeholder values in .env: ${missing.join(', ')}`)

if (process.argv.includes('--dry-run')) {
  console.log(`Ready to set ${variables.length} Actions Variables in ${repository}:`)
  for (const [name] of variables) console.log(`- ${name}`)
  console.log(`Worker: ${workerUrl.origin + workerUrl.pathname}`)
  process.exit(0)
}

const auth = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' })
if (auth.error?.code === 'ENOENT') fail('GitHub CLI (gh) is not installed. Install it and run `gh auth login` first.')
if (auth.status !== 0) fail('GitHub CLI is not authenticated. Run `gh auth login` and retry.')

for (const [name, value] of variables) {
  const result = spawnSync('gh', ['variable', 'set', name, '--repo', repository, '--body', value], {
    stdio: 'ignore',
  })
  if (result.error) fail(`Could not set ${name}: ${result.error.message}`)
  if (result.status !== 0) fail(`Could not set ${name}. Check repository permissions and GitHub CLI output with \`gh variable set ${name} --repo ${repository}\`.`)
}

console.log(`Configured ${variables.length} Actions Variables in ${repository}. Values were not printed.`)
