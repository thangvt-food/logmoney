import { chmod, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'

const serviceAccountPath = new URL('../worker/adminsdk.json', import.meta.url)
const devVarsPath = new URL('../.dev.vars', import.meta.url)
const port = 8787
let serviceAccount

try {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
} catch {
  console.error(`Port ${port} is already in use. Stop the existing local Worker before starting another one.`)
  process.exit(1)
}

try {
  serviceAccount = JSON.parse(await readFile(serviceAccountPath, 'utf8'))
} catch (error) {
  const reason = error instanceof Error ? error.message : 'unknown error'
  console.error(`Cannot read worker/adminsdk.json: ${reason}`)
  process.exit(1)
}

if (
  typeof serviceAccount.project_id !== 'string'
  || !serviceAccount.project_id
  || typeof serviceAccount.client_email !== 'string'
  || typeof serviceAccount.private_key !== 'string'
) {
  console.error('worker/adminsdk.json is missing project_id, client_email, or private_key.')
  process.exit(1)
}

try {
  const testToken = `lmcp_test_${randomBytes(32).toString('hex')}`
  await writeFile(
    devVarsPath,
    `FIREBASE_PROJECT_ID=${serviceAccount.project_id}\nSERVICE_ACCOUNT_JSON=${JSON.stringify(serviceAccount)}\nMCP_TEST_TOKEN=${testToken}\n`,
    { mode: 0o600 },
  )
  await chmod(devVarsPath, 0o600)
  console.log(`Local MCP sandbox token (data isolated under users/mcp-sandbox): ${testToken}`)
  console.log('Connect your MCP client to http://localhost:8787/mcp with this Bearer token.')
} catch (error) {
  const reason = error instanceof Error ? error.message : 'unknown error'
  console.error(`Cannot write local Worker secrets: ${reason}`)
  process.exit(1)
}

const child = spawn('npx', ['wrangler', 'dev', '--port', '8787'], {
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(`Could not start Wrangler: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exitCode = code ?? 1
  }
})
