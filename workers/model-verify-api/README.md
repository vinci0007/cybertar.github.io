# Model Verify API Worker

Thin Cloudflare Worker API for `lab/model-verifier.html`.

## Endpoints

- `GET /model-verify-reports` returns public shared reports.
- `POST /model-verify-reports` accepts one sanitized report and upserts by homepage domain.
- `POST /model-verify-proxy` proxies official OpenAI/Anthropic model verification requests so the static page is not blocked by browser CORS.

The Worker never exposes database credentials to the browser.

## Cockroach Cloud Setup

Create the table first:

```sql
-- Run scripts/model-verify-cockroach.sql in Cockroach Cloud.
```

Recommended connection path:

```bash
npx wrangler hyperdrive create cybertar-model-verify-db \
  --connection-string="postgresql://USER:PASSWORD@HOST:26257/db1?sslmode=verify-full"
```

Then edit `wrangler.toml` and uncomment the `[[hyperdrive]]` block with the generated id.

Quick fallback without Hyperdrive:

```bash
npx wrangler secret put DATABASE_URL
```

## Deploy

```bash
cd workers/model-verify-api
npm install
npm run check
npm run deploy
```

After deployment, set the Pages build secret:

```text
MODEL_VERIFY_CUSTOM_ENDPOINT=https://<worker-domain>/model-verify-reports
MODEL_VERIFY_PROXY_ENDPOINT=https://<worker-domain>/model-verify-proxy
```

Then rerun the Pages deploy so `lab/model-verify-share-config.js` points to the Worker.
