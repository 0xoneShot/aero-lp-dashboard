// Serves public/ locally for a look before publishing: node scripts/serve.mjs [port]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain' }
const port = Number(process.argv[2] ?? 4173)
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const file = path.join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('not found'); return }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  fs.createReadStream(file).pipe(res)
}).listen(port, () => console.log(`http://localhost:${port}`))
