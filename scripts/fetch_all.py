#!/usr/bin/env python3
"""
Asstar Data Fetcher - Unified CLI
Consolidates all scrapers into a single entry point.
"""

import os
import sys
import json
import time
import argparse
import re
from datetime import datetime, date, timezone
from email.utils import format_datetime
from html import escape as html_escape
from typing import Dict, List, Any, Optional
from urllib.parse import urlencode
from xml.sax.saxutils import escape as xml_escape

import requests
from bs4 import BeautifulSoup

# --- Common Utilities ---

class BaseScraper:
    def __init__(self, user_agent: Optional[str] = None):
        self.session = requests.Session()
        ua = user_agent or 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
        self.session.headers.update({'User-Agent': ua})
        self.timeout = 30
        self.max_retries = 3

    def get(self, url: str) -> str:
        for attempt in range(1, self.max_retries + 1):
            try:
                resp = self.session.get(url, timeout=self.timeout)
                resp.raise_for_status()
                # Ensure correct encoding for Tophub and others
                resp.encoding = resp.apparent_encoding or 'utf-8'
                return resp.text
            except Exception as e:
                if attempt == self.max_retries:
                    raise
                print(f"  Attempt {attempt} failed for {url}: {e}. Retrying...")
                time.sleep(attempt * 2)
        return ""

def get_output_path(filename: str) -> str:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    feeds_dir = os.path.join(os.path.dirname(script_dir), 'feeds')
    os.makedirs(feeds_dir, exist_ok=True)
    return os.path.join(feeds_dir, filename)

# --- GitHub Trending Scraper ---

class GitHubTrendingScraper(BaseScraper):
    def _parse_repo_article(self, article) -> Optional[Dict[str, Any]]:
        try:
            repo_link = article.find('h2', class_='h3').find('a')
            repo_name = repo_link.get_text(strip=True)
            repo_url = 'https://github.com' + repo_link.get('href')
            description_elem = article.find('p')
            description = description_elem.get_text(strip=True) if description_elem else 'No description available'
            language_elem = article.find(attrs={'itemprop': 'programmingLanguage'})
            language = language_elem.get_text(strip=True) if language_elem else 'Unknown'
            stars_elem = article.find('a', href=re.compile(r'/stargazers'))
            stars_text = stars_elem.get_text(strip=True) if stars_elem else '0'
            stars = re.sub(r'[^\d]', '', stars_text) or '0'
            forks_elem = article.find('a', href=re.compile(r'/forks'))
            forks_text = forks_elem.get_text(strip=True) if forks_elem else '0'
            forks = re.sub(r'[^\d]', '', forks_text) or '0'
            stars_today_elem = article.find('span', class_='d-inline-block float-sm-right')
            stars_today_text = stars_today_elem.get_text(strip=True) if stars_today_elem else '0'
            stars_today = re.sub(r'[^\d]', '', stars_today_text) or '0'
            built_by = []
            avatar_imgs = article.find_all('img', class_='avatar')
            for img in avatar_imgs[:5]:
                username = img.get('alt', '').replace('@', '')
                if username: built_by.append(f"@{username}")
            
            return {
                'name': repo_name, 'description': description, 'language': language,
                'stars': f"{int(stars):,}", 'forks': f"{int(forks):,}",
                'starsToday': f"{int(stars_today):,}", 'url': repo_url, 'builtBy': built_by
            }
        except Exception as e:
            print(f"  Error parsing GitHub repo: {e}")
            return None

    def run(self):
        periods = ['daily', 'weekly', 'monthly']
        all_data = {}
        for period in periods:
            print(f"Fetching GitHub Trending ({period})...")
            url = f'https://github.com/trending?since={period}' if period != 'daily' else 'https://github.com/trending'
            html = self.get(url)
            soup = BeautifulSoup(html, 'html.parser')
            repos = []
            for article in soup.find_all('article', class_='Box-row')[:25]:
                data = self._parse_repo_article(article)
                if data: repos.append(data)
            all_data[period] = repos
            time.sleep(2)

        output = {**all_data, 'lastUpdated': datetime.now().isoformat(), 'totalRepositories': sum(len(r) for r in all_data.values())}
        with open(get_output_path('trending-data.json'), 'w', encoding='utf-8') as f:
            json.dump(output, f, indent=2, ensure_ascii=False)
        print(f"Saved GitHub Trending data. Total: {output['totalRepositories']}")

# --- HuggingFace Models Scraper ---

class HuggingFaceScraper(BaseScraper):
    def run(self):
        api_base = 'https://huggingface.co/api/models'
        categories = ['trending', 'likes', 'downloads']
        all_data = {}
        for cat in categories:
            print(f"Fetching HuggingFace Models ({cat})...")
            url = f"{api_base}?{urlencode({'sort': cat, 'limit': 25})}"
            if cat == 'trending':
                url = f"{api_base}?{urlencode({'trending': 'true', 'limit': 25})}"
            
            resp = self.session.get(url, timeout=self.timeout)
            items = resp.json() if resp.status_code == 200 else []
            
            parsed_models = []
            for item in items[:25]:
                model_id = item.get('modelId') or item.get('id') or ''
                if not model_id: continue
                parsed_models.append({
                    'name': model_id,
                    'description': item.get('description') or item.get('cardData', {}).get('description') or 'No description available',
                    'task': item.get('pipeline_tag') or 'Unknown',
                    'parameters': item.get('cardData', {}).get('parameters') or 'Unknown',
                    'likes': f"{int(item.get('likes') or 0):,}",
                    'downloads': f"{int(item.get('downloads') or 0):,}",
                    'url': f"https://huggingface.co/{model_id}",
                    'tags': (item.get('tags') or item.get('cardData', {}).get('tags') or [])[:5]
                })
            all_data[cat] = parsed_models
            time.sleep(2)

        output = {**all_data, 'lastUpdated': datetime.now().isoformat(), 'totalModels': sum(len(m) for m in all_data.values())}
        dest = get_output_path('huggingface-data.json')
        if output['totalModels'] > 0 or not os.path.exists(dest):
            with open(dest, 'w', encoding='utf-8') as f:
                json.dump(output, f, indent=2, ensure_ascii=False)
        print(f"Saved HuggingFace Models data. Total: {output['totalModels']}")

# --- HuggingFace Papers Scraper ---

class HFPapersScraper(BaseScraper):
    def _parse_papers(self, html: str) -> List[Dict[str, Any]]:
        soup = BeautifulSoup(html, 'lxml')
        items = []
        for article in soup.select('article, div[data-testid="paper-card"], li'):
            a = article.select_one('a[href^="/papers/"]')
            if not a: continue
            href = a.get('href', '')
            url = f"https://huggingface.co{href}" if href.startswith('/') else href
            title_node = article.find(['h2', 'h3']) or a.find(['h2', 'h3'])
            title = (title_node.get_text(strip=True) if title_node else None) or a.get('title') or a.get_text(strip=True)
            if not title: continue
            card_text = article.get_text(separator=' ', strip=True)
            abstract = re.sub(re.escape(title), '', card_text).strip()[:240] if card_text else 'No abstract available.'
            items.append({'title': title, 'authors': 'Unknown', 'abstract': abstract, 'url': url})
        
        if not items: # Fallback
            for a in soup.select('a[href^="/papers/"]'):
                href = a.get('href', ''); url = f"https://huggingface.co{href}" if href.startswith('/') else href
                title = a.get('title') or a.get_text(strip=True)
                if title: items.append({'title': title, 'authors': 'Unknown', 'abstract': 'No abstract available.', 'url': url})
        
        dedup = {f"{it['title']}|{it['url']}": it for it in items}
        return list(dedup.values())[:50]

    def run(self):
        today = date.today()
        year, week_num, _ = today.isocalendar()
        print(f"Fetching HuggingFace Papers...")
        payload = {}
        targets = {
            'daily': f"https://huggingface.co/papers/date/{today.strftime('%Y-%m-%d')}",
            'weekly': f"https://huggingface.co/papers/week/{year}-W{week_num:02d}",
            'monthly': f"https://huggingface.co/papers/month/{today.year}-{today.month:02d}",
            'trending': "https://huggingface.co/papers/trending"
        }
        for key, url in targets.items():
            try:
                payload[key] = self._parse_papers(self.get(url))
                time.sleep(2)
            except Exception as e:
                print(f"  Failed {key}: {e}"); payload[key] = []
        
        payload['lastUpdated'] = datetime.now().isoformat()
        payload['totals'] = {k: len(v) for k, v in payload.items() if isinstance(v, list)}
        dest = get_output_path('huggingface-papers-data.json')
        if sum(payload['totals'].values()) > 0 or not os.path.exists(dest):
            with open(dest, 'w', encoding='utf-8') as f:
                json.dump(payload, f, indent=2, ensure_ascii=False)
        print(f"Saved HuggingFace Papers data. Total: {sum(payload['totals'].values())}")

# --- Tophub Focus Scraper ---

class TophubScraper(BaseScraper):
    def run(self):
        specs = {
            'finance': {'url': 'https://tophub.today/c/finance', 'targets': ['第一财经', '雪球', '华尔街见闻', '集思录']},
            'tech': {'url': 'https://tophub.today/c/tech', 'targets': ['36氪', '少数派', 'IT之家']},
            'developer': {'url': 'https://tophub.today/c/developer', 'targets': ['CSDN', '人人都是产品经理', '掘金']}
        }
        output = {'savedAt': datetime.now().isoformat(), 'categories': {}}
        for cat, spec in specs.items():
            print(f"Fetching Tophub ({cat})...")
            html = self.get(spec['url'])
            soup = BeautifulSoup(html, 'lxml')
            cards = soup.select('.cc-cd')
            parsed = {t: [] for t in spec['targets']}
            for card in cards:
                label = card.select_one('.cc-cd-lb').get_text(strip=True) if card.select_one('.cc-cd-lb') else ''
                target = next((t for t in spec['targets'] if t in label), None)
                if not target: continue
                s_title = card.select_one('.cc-cd-sb-st').get_text(strip=True) if card.select_one('.cc-cd-sb-st') else ''
                items = []
                for a in card.select('.cc-cd-cb a[href]'):
                    href = a.get('href', '').strip()
                    if not (href.startswith('http')): continue
                    row = a.select_one('.cc-cd-cb-ll')
                    if not row: continue
                    items.append({
                        'rank': row.select_one('.s').get_text(strip=True) if row.select_one('.s') else '',
                        'title': row.select_one('.t').get_text(strip=True) if row.select_one('.t') else '',
                        'extra': row.select_one('.e').get_text(strip=True) if row.select_one('.e') else '',
                        'url': href
                    })
                parsed[target].append({'section': s_title, 'items': items})
            output['categories'][cat] = {'sourceUrl': spec['url'], 'sections': parsed}
            time.sleep(2)

        # EastMoney Integration
        try:
            print("Fetching EastMoney...")
            em_html = self.get('https://finance.eastmoney.com/yaowen.html')
            em_soup = BeautifulSoup(em_html, 'lxml')
            em_items = []
            seen = set()
            for a in em_soup.select('a[href*="/a/"]')[:30]:
                href = a.get('href', '').strip()
                title = a.get_text(strip=True)
                if not title or len(title) < 6 or '查看' in title: continue
                if href.startswith('/'): href = 'https://finance.eastmoney.com' + href
                if title not in seen:
                    seen.add(title)
                    em_items.append({'rank': '', 'title': title, 'extra': '', 'url': href})
            output['categories'].setdefault('finance', {}) \
                  .setdefault('sections', {})['东方财富网'] = [{'section': '焦点要闻', 'items': em_items}]
        except Exception as e:
            print(f"  Warning: EastMoney failed: {e}")

        with open(get_output_path('realtime-focus.json'), 'w', encoding='utf-8') as f:
            json.dump(output, f, indent=2, ensure_ascii=False)
        print("Saved Tophub Focus data.")

# --- RSS Generator ---

class RSSGenerator:
    """Generate static RSS 2.0 feeds from the JSON files written by other scrapers."""

    SITE_URL = "https://cybertar.youngood.tech"
    SITE_NAME = "Cybertar"

    FEEDS = [
        {
            'file': 'github-trending-daily.xml',
            'source': 'trending-data.json',
            'key': 'daily',
            'kind': 'github',
            'title': 'GitHub Trending — Daily',
            'description': 'Top GitHub repositories trending today, curated by Cybertar.',
            'page': '/trending-project.html',
        },
        {
            'file': 'github-trending-weekly.xml',
            'source': 'trending-data.json',
            'key': 'weekly',
            'kind': 'github',
            'title': 'GitHub Trending — Weekly',
            'description': 'Top GitHub repositories trending this week, curated by Cybertar.',
            'page': '/trending-project.html',
        },
        {
            'file': 'github-trending-monthly.xml',
            'source': 'trending-data.json',
            'key': 'monthly',
            'kind': 'github',
            'title': 'GitHub Trending — Monthly',
            'description': 'Top GitHub repositories trending this month, curated by Cybertar.',
            'page': '/trending-project.html',
        },
        {
            'file': 'huggingface-models-trending.xml',
            'source': 'huggingface-data.json',
            'key': 'trending',
            'kind': 'hf_model',
            'title': 'HuggingFace Models — Trending',
            'description': 'Trending models on HuggingFace, curated by Cybertar.',
            'page': '/trending-project.html',
        },
        {
            'file': 'huggingface-models-likes.xml',
            'source': 'huggingface-data.json',
            'key': 'likes',
            'kind': 'hf_model',
            'title': 'HuggingFace Models — Most Likes',
            'description': 'Most-liked models on HuggingFace, curated by Cybertar.',
            'page': '/trending-project.html',
        },
        {
            'file': 'huggingface-models-downloads.xml',
            'source': 'huggingface-data.json',
            'key': 'downloads',
            'kind': 'hf_model',
            'title': 'HuggingFace Models — Most Downloads',
            'description': 'Most-downloaded models on HuggingFace, curated by Cybertar.',
            'page': '/trending-project.html',
        },
        {
            'file': 'huggingface-papers-daily.xml',
            'source': 'huggingface-papers-data.json',
            'key': 'daily',
            'kind': 'hf_paper',
            'title': 'HuggingFace Papers — Daily',
            'description': 'Daily picks from HuggingFace Papers, curated by Cybertar.',
            'page': '/huggingface-papers.html',
        },
        {
            'file': 'huggingface-papers-weekly.xml',
            'source': 'huggingface-papers-data.json',
            'key': 'weekly',
            'kind': 'hf_paper',
            'title': 'HuggingFace Papers — Weekly',
            'description': 'Weekly picks from HuggingFace Papers, curated by Cybertar.',
            'page': '/huggingface-papers.html',
        },
        {
            'file': 'huggingface-papers-monthly.xml',
            'source': 'huggingface-papers-data.json',
            'key': 'monthly',
            'kind': 'hf_paper',
            'title': 'HuggingFace Papers — Monthly',
            'description': 'Monthly picks from HuggingFace Papers, curated by Cybertar.',
            'page': '/huggingface-papers.html',
        },
        {
            'file': 'huggingface-papers-trending.xml',
            'source': 'huggingface-papers-data.json',
            'key': 'trending',
            'kind': 'hf_paper',
            'title': 'HuggingFace Papers — Trending',
            'description': 'Trending papers on HuggingFace, curated by Cybertar.',
            'page': '/huggingface-papers.html',
        },
    ]

    def _load_source(self, filename: str) -> Optional[Dict[str, Any]]:
        path = get_output_path(filename)
        if not os.path.exists(path):
            return None
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"  RSS: failed to read {filename}: {e}")
            return None

    @staticmethod
    def _parse_iso(value: Any) -> datetime:
        if isinstance(value, str) and value:
            try:
                dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except Exception:
                pass
        return datetime.now(timezone.utc)

    @staticmethod
    def _h(value: Any) -> str:
        return html_escape(str(value) if value is not None else '', quote=False)

    @staticmethod
    def _x(value: Any) -> str:
        return xml_escape(str(value) if value is not None else '')

    def _render_github(self, item: Dict[str, Any]) -> Dict[str, str]:
        h = self._h
        name = item.get('name') or 'Unknown'
        stars = item.get('stars') or '0'
        stars_today = item.get('starsToday') or '0'
        title = f"{name} — ⭐{stars} (+{stars_today} today)"
        built_by = ', '.join(item.get('builtBy') or [])
        body_parts = [
            f"<p>{h(item.get('description') or 'No description available')}</p>",
            "<ul>",
            f"<li><strong>Language:</strong> {h(item.get('language') or 'Unknown')}</li>",
            f"<li><strong>Stars:</strong> {h(stars)} (+{h(stars_today)} today)</li>",
            f"<li><strong>Forks:</strong> {h(item.get('forks') or '0')}</li>",
        ]
        if built_by:
            body_parts.append(f"<li><strong>Built by:</strong> {h(built_by)}</li>")
        body_parts.append("</ul>")
        return {
            'title': title,
            'link': item.get('url') or '',
            'description': ''.join(body_parts),
        }

    def _render_hf_model(self, item: Dict[str, Any]) -> Dict[str, str]:
        h = self._h
        name = item.get('name') or 'Unknown'
        likes = item.get('likes') or '0'
        downloads = item.get('downloads') or '0'
        title = f"{name} — ❤{likes} · ⬇{downloads}"
        tags = ', '.join(item.get('tags') or [])
        body_parts = [
            f"<p>{h(item.get('description') or 'No description available')}</p>",
            "<ul>",
            f"<li><strong>Task:</strong> {h(item.get('task') or 'Unknown')}</li>",
            f"<li><strong>Parameters:</strong> {h(item.get('parameters') or 'Unknown')}</li>",
            f"<li><strong>Likes:</strong> {h(likes)}</li>",
            f"<li><strong>Downloads:</strong> {h(downloads)}</li>",
        ]
        if tags:
            body_parts.append(f"<li><strong>Tags:</strong> {h(tags)}</li>")
        body_parts.append("</ul>")
        return {
            'title': title,
            'link': item.get('url') or '',
            'description': ''.join(body_parts),
        }

    def _render_hf_paper(self, item: Dict[str, Any]) -> Dict[str, str]:
        h = self._h
        title = item.get('title') or 'Untitled paper'
        authors = item.get('authors') or 'Unknown'
        abstract = item.get('abstract') or 'No abstract available.'
        body_parts = [
            f"<p><strong>Authors:</strong> {h(authors)}</p>",
            f"<p>{h(abstract)}</p>",
        ]
        return {
            'title': title,
            'link': item.get('url') or '',
            'description': ''.join(body_parts),
        }

    def _render_item(self, kind: str, item: Dict[str, Any]) -> Optional[Dict[str, str]]:
        if not isinstance(item, dict):
            return None
        if kind == 'github':
            rendered = self._render_github(item)
        elif kind == 'hf_model':
            rendered = self._render_hf_model(item)
        elif kind == 'hf_paper':
            rendered = self._render_hf_paper(item)
        else:
            return None
        if not rendered.get('link'):
            return None
        return rendered

    def _build_xml(self, feed: Dict[str, Any], items: List[Dict[str, Any]],
                   build_dt: datetime, last_dt: datetime) -> str:
        x = self._x
        feed_url = f"{self.SITE_URL}/feeds/rss/{feed['file']}"
        page_url = f"{self.SITE_URL}{feed['page']}"
        last_build = format_datetime(build_dt)
        pub_date = format_datetime(last_dt)

        lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
            '<channel>',
            f'<title>{x(feed["title"])}</title>',
            f'<link>{x(page_url)}</link>',
            f'<description>{x(feed["description"])}</description>',
            '<language>en</language>',
            f'<generator>{x(self.SITE_NAME)} RSS Generator</generator>',
            f'<lastBuildDate>{x(last_build)}</lastBuildDate>',
            f'<pubDate>{x(pub_date)}</pubDate>',
            f'<atom:link href="{x(feed_url)}" rel="self" type="application/rss+xml" />',
        ]

        for raw in items:
            rendered = self._render_item(feed['kind'], raw)
            if not rendered:
                continue
            lines.append('<item>')
            lines.append(f'<title>{x(rendered["title"])}</title>')
            lines.append(f'<link>{x(rendered["link"])}</link>')
            lines.append(f'<guid isPermaLink="true">{x(rendered["link"])}</guid>')
            lines.append(f'<pubDate>{x(pub_date)}</pubDate>')
            lines.append(f'<description><![CDATA[{rendered["description"]}]]></description>')
            lines.append('</item>')

        lines.append('</channel>')
        lines.append('</rss>')
        return '\n'.join(lines) + '\n'

    def run(self):
        rss_dir = get_output_path('rss')
        os.makedirs(rss_dir, exist_ok=True)

        sources: Dict[str, Optional[Dict[str, Any]]] = {}
        for feed in self.FEEDS:
            if feed['source'] not in sources:
                sources[feed['source']] = self._load_source(feed['source'])

        build_dt = datetime.now(timezone.utc)
        written = 0
        for feed in self.FEEDS:
            data = sources.get(feed['source'])
            if not data:
                print(f"  RSS: skip {feed['file']} — source {feed['source']} missing")
                continue
            items = data.get(feed['key'])
            if not isinstance(items, list) or not items:
                print(f"  RSS: skip {feed['file']} — empty key '{feed['key']}'")
                continue
            last_dt = self._parse_iso(data.get('lastUpdated'))
            xml_text = self._build_xml(feed, items, build_dt, last_dt)
            out_path = os.path.join(rss_dir, feed['file'])
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(xml_text)
            written += 1
            print(f"  RSS: wrote {feed['file']} ({len(items)} items)")

        print(f"Saved {written}/{len(self.FEEDS)} RSS feeds to {rss_dir}")

# --- CLI Entry Point ---

def main():
    parser = argparse.ArgumentParser(description="Asstar Data Fetcher")
    parser.add_argument('target', choices=['github', 'huggingface', 'papers', 'focus', 'rss', 'all'], help="Target data to fetch")
    args = parser.parse_args()

    scrapers = {
        'github': GitHubTrendingScraper(),
        'huggingface': HuggingFaceScraper(),
        'papers': HFPapersScraper(),
        'focus': TophubScraper(),
        'rss': RSSGenerator(),
    }

    if args.target == 'all':
        order = ['github', 'huggingface', 'papers', 'focus', 'rss']
        for name in order:
            try:
                scrapers[name].run()
            except Exception as e:
                print(f"Critical error in {name}: {e}")
    else:
        scrapers[args.target].run()

if __name__ == "__main__":
    main()
