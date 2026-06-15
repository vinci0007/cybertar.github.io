const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE_URL = 'https://cybertar.youngood.tech';
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '_site');

const excluded = new Set(['.git', '.github', '.vscode', '.claude', '_site', 'node_modules', 'output', '.gitignore']);

const routeDefinitions = [
  { source: 'index.html', route: '/' },
  { source: 'blogs/index.html', route: '/blogs/' },
  { source: 'space.html', route: '/space/' },
  { source: 'trending-project.html', route: '/trending-project/' },
  { source: 'huggingface-papers.html', route: '/huggingface-papers/' },
  { source: 'tools.html', route: '/tools/' },
  { source: 'focus.html', route: '/focus/' },
  { source: 'knowsnews/techKnows.html', route: '/knowsnews/techKnows/' },
  { source: 'entertainment/index.html', route: '/entertainment/' },
  { source: 'entertainment/lx_online/index.html', route: '/entertainment/lx_online/' },
  { source: 'projects.html', route: '/projects/' },
  { source: 'project-view.html', route: '/project-view/' },
  { source: 'voice-denoise.html', route: '/voice-denoise/' },
  { source: 'lab/model-verifier.html', route: '/lab/model-verifier/' },
  { source: 'lab/prompt-optimizer.html', route: '/lab/prompt-optimizer/' },
  { source: 'lab/svg-monitor.html', route: '/lab/svg-monitor/' },
];

const routes = routeDefinitions.filter(({ source }) => fs.existsSync(path.join(root, source)));
const skippedRoutes = routeDefinitions.filter(({ source }) => !fs.existsSync(path.join(root, source)));

const htmlRouteMap = new Map(routes.map(({ source, route }) => [toPosix(source), route]));
const sourceRouteMap = new Map(routes.map(({ source, route }) => [toPosix(source), route]));
const legacyRouteMap = Object.fromEntries(routes.map(({ source, route }) => [`/${toPosix(source)}`, route]));
const assetHashCache = new Map();

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function emptyDir(dir) {
  ensureDir(dir);
  for (const entry of fs.readdirSync(dir)) {
    const target = path.join(dir, entry);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      if (error.code === 'EPERM') {
        try {
          fs.chmodSync(target, 0o666);
          fs.rmSync(target, { recursive: true, force: true });
          continue;
        } catch {
          if (entry === '.codex-http-server.pid') continue;
        }
      }
      throw error;
    }
  }
}

function walk(dir, callback) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, callback);
    } else {
      callback(fullPath);
    }
  }
}

function isExternalUrl(url) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url);
}

function shouldLeaveUrl(url) {
  return (
    !url ||
    url.startsWith('#') ||
    url.startsWith('?') ||
    isExternalUrl(url) ||
    /^(?:mailto|tel|javascript|data):/i.test(url)
  );
}

function splitUrl(url) {
  const match = url.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match ? match[1] : url,
    search: match && match[2] ? match[2] : '',
    hash: match && match[3] ? match[3] : '',
  };
}

function cacheBustedAsset(relativePath) {
  return /\.(?:js|css)$/i.test(relativePath);
}

function contentHash(relativePath) {
  const normalized = toPosix(relativePath).replace(/^\/+/, '');
  if (assetHashCache.has(normalized)) return assetHashCache.get(normalized);
  const file = path.join(root, normalized);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    assetHashCache.set(normalized, '');
    return '';
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  assetHashCache.set(normalized, hash);
  return hash;
}

function withContentHash(pathname, search, hash, relativePath) {
  if (!cacheBustedAsset(relativePath)) return `${pathname}${search}${hash}`;
  const version = contentHash(relativePath);
  if (!version) return `${pathname}${search}${hash}`;
  const params = new URLSearchParams((search || '').replace(/^\?/, ''));
  params.set('v', version);
  return `${pathname}?${params.toString()}${hash || ''}`;
}

function resolveSitePath(fromFile, url) {
  if (shouldLeaveUrl(url)) return url;

  const { pathname, search, hash } = splitUrl(url);
  if (!pathname) return url;

  if (pathname.startsWith('/')) {
    const absolutePath = toPosix(path.normalize(pathname)).replace(/^\/+/, '');
    const cleanRoute = htmlRouteMap.get(absolutePath);
    if (cleanRoute) return `${cleanRoute}${search}${hash}`;
    return withContentHash(pathname, search, hash, absolutePath);
  }

  const fromDir = path.dirname(fromFile);
  const resolved = toPosix(path.normalize(path.join(fromDir, pathname))).replace(/^\.\//, '');
  const cleanRoute = htmlRouteMap.get(resolved);
  if (cleanRoute) return `${cleanRoute}${search}${hash}`;
  return withContentHash(`/${resolved}`, search, hash, resolved);
}

function injectSeo(html, route) {
  const canonical = `${SITE_URL}${route}`;
  const description = 'CyberTAR 汇聚 AI、开源趋势、效率工具与实时焦点，帮助创作者和开发者发现前沿项目、论文与灵感。';
  let next = html;

  if (/<link\s+rel=["']canonical["']/i.test(next)) {
    next = next.replace(/<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${canonical}">`);
  } else {
    next = next.replace(/<\/head>/i, `    <link rel="canonical" href="${canonical}">\n</head>`);
  }

  if (!/<meta\s+name=["']description["']/i.test(next)) {
    next = next.replace(/<\/head>/i, `    <meta name="description" content="${description}">\n</head>`);
  }

  if (!/<meta\s+name=["']robots["']/i.test(next)) {
    next = next.replace(/<\/head>/i, '    <meta name="robots" content="index, follow">\n</head>');
  }

  return next;
}

function transformHtml(html, relativeSource) {
  const sourcePath = toPosix(relativeSource);
  const route = sourceRouteMap.get(sourcePath);
  let next = html.replace(/\b(href|src)=["']([^"']+)["']/gi, (match, attr, url) => {
    return `${attr}="${resolveSitePath(sourcePath, url)}"`;
  });

  if (route) {
    next = injectSeo(next, route);
  }

  return next;
}

function copyFile(relativeSource) {
  const src = path.join(root, relativeSource);
  const dest = path.join(outDir, relativeSource);
  ensureDir(path.dirname(dest));

  if (relativeSource.toLowerCase().endsWith('.html')) {
    const html = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(dest, transformHtml(html, relativeSource));
  } else {
    fs.copyFileSync(src, dest);
  }
}

function routeOutputFile(route) {
  if (route === '/') return path.join(outDir, 'index.html');
  return path.join(outDir, route.replace(/^\//, ''), 'index.html');
}

function shouldSkipLegacyRoute(relativeSource) {
  const route = sourceRouteMap.get(toPosix(relativeSource));
  if (!route) return false;

  return path.resolve(root, relativeSource) !== routeOutputFile(route);
}

function writeCleanRoute(routeEntry) {
  const source = toPosix(routeEntry.source);
  const src = path.join(root, source);
  const dest = routeOutputFile(routeEntry.route);
  ensureDir(path.dirname(dest));
  const html = fs.readFileSync(src, 'utf8');
  fs.writeFileSync(dest, injectSeo(transformHtml(html, source), routeEntry.route));
}

function writeRobots() {
  const robots = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'robots.txt'), robots);
}

function writeSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = routes
    .map(({ route }) => {
      const loc = `${SITE_URL}${route}`;
      return [
        '  <url>',
        `    <loc>${loc}</loc>`,
        `    <lastmod>${today}</lastmod>`,
        '    <changefreq>weekly</changefreq>',
        route === '/' ? '    <priority>1.0</priority>' : '    <priority>0.8</priority>',
        '  </url>',
      ].join('\n');
    })
    .join('\n');

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'sitemap.xml'), xml);
}

function write404() {
  const cleanRoutes = JSON.stringify(routes.map(({ route }) => route));
  const legacyRoutes = JSON.stringify(legacyRouteMap);
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>页面未找到 | CyberTAR</title>
  <meta name="robots" content="noindex, follow">
  <script>
    const cleanRoutes = ${cleanRoutes};
    const legacyRoutes = ${legacyRoutes};
    const path = window.location.pathname;
    if (legacyRoutes[path]) {
      window.location.replace(legacyRoutes[path] + window.location.search + window.location.hash);
    }
    const slashRoute = path.endsWith('/') ? path : path + '/';
    if (cleanRoutes.includes(slashRoute)) {
      window.location.replace(slashRoute + window.location.search + window.location.hash);
    }
  </script>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050505;color:#fff;font-family:Arial,sans-serif}
    main{max-width:560px;padding:32px;text-align:center}
    a{color:#fff}
  </style>
</head>
<body>
  <main>
    <h1>404</h1>
    <p>页面不存在，或地址已经移动。</p>
    <p><a href="/">返回首页</a></p>
  </main>
  <script src="/script.js"></script>
</body>
</html>
`;
  fs.writeFileSync(path.join(outDir, '404.html'), html);
}

emptyDir(outDir);

for (const { source, route } of skippedRoutes) {
  console.warn(`Skipping ${route}: ${source} does not exist`);
}

walk(root, (fullPath) => {
  const relativeSource = toPosix(path.relative(root, fullPath));
  if (shouldSkipLegacyRoute(relativeSource)) return;
  copyFile(relativeSource);
});

for (const routeEntry of routes) {
  writeCleanRoute(routeEntry);
}

fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
writeRobots();
writeSitemap();
write404();

console.log(`Built ${routes.length} clean routes in ${path.relative(root, outDir)}`);
