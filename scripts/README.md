# Asstar 自动化数据更新脚本

这是 Asstar 项目的统一数据爬取入口。

## 快速开始

所有的爬虫功能都已整合到 `fetch_all.py` 中。

### 安装依赖
```bash
pip install -r scripts/requirements.txt
```

### 使用方法
```bash
# 更新所有数据 (GitHub, HuggingFace Models, HuggingFace Papers, Tophub/Focus)
python scripts/fetch_all.py all

# 仅更新 GitHub Trending
python scripts/fetch_all.py github

# 仅更新 HuggingFace Models
python scripts/fetch_all.py huggingface

# 仅更新 HuggingFace Papers
python scripts/fetch_all.py papers

# 仅更新 实时焦点 (Tophub)
python scripts/fetch_all.py focus
```

## 输出文件
脚本会将结果保存到项目根目录下的 `feeds/` 文件夹中：
- `feeds/trending-data.json`
- `feeds/huggingface-data.json`
- `feeds/huggingface-papers-data.json`
- `feeds/realtime-focus.json`
- `feeds/model-verify-reports.json`

## 模型验真分享汇总

`lab/model-verifier.html` 支持用户手动分享脱敏后的模型验真报告。默认使用 Supabase REST API，也可以接入自定义接口。

### Supabase 建表

在 Supabase SQL Editor 中执行：

```sql
-- 见 scripts/model-verify-supabase.sql
```

该 SQL 会创建 `model_verify_reports` 表，并开启匿名读取、按官网域名 upsert 的 RLS 策略。

### GitHub Secrets

部署时可配置以下 Secrets：

- `MODEL_VERIFY_SUPABASE_URL`
- `MODEL_VERIFY_SUPABASE_ANON_KEY`
- `MODEL_VERIFY_SUPABASE_TABLE`，可选，默认 `model_verify_reports`
- `MODEL_VERIFY_SHARE_TYPE`，可选，默认 `supabase`
- `MODEL_VERIFY_CUSTOM_ENDPOINT`，可选；配置后前端会改用自定义接口读写

部署工作流会生成 `lab/model-verify-share-config.js`，并把公开汇总写入 `feeds/model-verify-reports.json`。未配置数据库时，脚本会生成空汇总，页面显示静态兜底提示。

### Cockroach Cloud 汇总读取

如果使用 Cockroach Cloud，只能在 GitHub Actions 或自定义后端中使用数据库密码，不能把密码写入静态前端。仓库的 `database` environment 可配置：

- Secret `COCKROACHLABS_CLOUD_DB1`：Cockroach Cloud `db1` 密码
- Secret `MODEL_VERIFY_COCKROACH_DATABASE_URL`：可选，完整 PostgreSQL 连接串
- Variable `MODEL_VERIFY_FEED_SOURCE=cockroach`
- Variable `MODEL_VERIFY_COCKROACH_HOST`：未使用完整连接串时必填
- Variable `MODEL_VERIFY_COCKROACH_USER`：未使用完整连接串时必填
- Variable `MODEL_VERIFY_COCKROACH_DATABASE`，可选，默认 `db1`
- Variable `MODEL_VERIFY_COCKROACH_TABLE`，可选，默认 `model_verify_reports`
- Variable `MODEL_VERIFY_COCKROACH_PORT`，可选，默认 `26257`

建表 SQL：

```sql
-- 见 scripts/model-verify-cockroach.sql
```

Cockroach 模式会让 Actions 从数据库生成公开 feed。用户从网页直接提交报告仍需要配置 `MODEL_VERIFY_CUSTOM_ENDPOINT` 指向你自己的后端，由后端安全地写入 Cockroach。

本仓库提供了一个最小 Cloudflare Worker 后端：

```bash
cd workers/model-verify-api
npm install
npm run check
npm run deploy
```

部署说明见 `workers/model-verify-api/README.md`。Worker 部署后，把 `MODEL_VERIFY_CUSTOM_ENDPOINT` 配成 `https://<worker-domain>/model-verify-reports`。

### 本地生成

```bash
node scripts/generate-model-verify-config.js
node scripts/generate-model-verify-feed.js
```

## GitHub Actions
本项目配置了 GitHub Actions 自动更新。配置文件位于 `.github/workflows/update-feeds.yml`，每天会自动运行两次。
