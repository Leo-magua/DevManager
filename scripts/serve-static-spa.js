#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
};

function readArgs(argv) {
  const args = {
    host: '0.0.0.0',
    port: 3991,
    dir: process.cwd(),
    fallback: 'index.html'
  };

  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--host' && value) {
      args.host = value;
      index += 1;
    } else if (key === '--port' && value) {
      args.port = Number(value);
      index += 1;
    } else if (key === '--dir' && value) {
      args.dir = value;
      index += 1;
    } else if (key === '--fallback' && value) {
      args.fallback = value;
      index += 1;
    }
  }

  return args;
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'
  });
  stream.pipe(res);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal Server Error');
  });
}

function resolveFile(rootDir, fallbackFile, url) {
  const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  const relativePath = pathname === '/' ? fallbackFile : pathname.replace(/^\/+/, '');
  const candidate = path.resolve(rootDir, relativePath);

  if (candidate.startsWith(rootDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  return path.join(rootDir, fallbackFile);
}

const args = readArgs(process.argv);
const rootDir = path.resolve(args.dir);
const fallbackFile = args.fallback;

if (!fs.existsSync(path.join(rootDir, fallbackFile))) {
  console.error(`[static] Missing fallback file: ${path.join(rootDir, fallbackFile)}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const filePath = resolveFile(rootDir, fallbackFile, req.url);
  sendFile(res, filePath);
});

server.listen(args.port, args.host, () => {
  console.log(`[static] Serving ${rootDir} at http://${args.host}:${args.port}/`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
