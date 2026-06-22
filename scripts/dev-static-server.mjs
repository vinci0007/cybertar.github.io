import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer } from 'node:http';

const root = resolve(process.argv[2] || '_site');
const port = Number(process.argv[3] || process.env.PORT || 4177);

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
};

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  let pathname = decoded === '/' ? '/index.html' : decoded;

  if (!extname(pathname)) {
    pathname = pathname.endsWith('/') ? `${pathname}index.html` : `${pathname}/index.html`;
  }

  const fullPath = normalize(join(root, pathname));
  if (!fullPath.startsWith(root)) {
    return null;
  }

  return fullPath;
}

const server = createServer((req, res) => {
  const filePath = resolvePath(req.url || '/');

  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'content-type': types[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}`);
});
