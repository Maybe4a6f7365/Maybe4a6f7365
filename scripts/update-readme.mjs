#!/usr/bin/env node
/**
 * Rewrites the blog-posts marker section of README.md in place.
 *
 * Markers: <!-- blog-posts:start --> ... <!-- blog-posts:end -->
 *
 * No third-party dependencies. This process holds a token with write
 * access to the profile repo, so the dependency tree stays at zero.
 *
 * Node 20+ (global fetch).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const README = join(ROOT, 'README.md');

const cfg = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
const FEED = process.env.FEED_URL || cfg.feedUrl || '';

const UA = { 'User-Agent': `${cfg.username}-profile-updater` };

/* ------------------------------------------------------------------ *
 * Untrusted input handling
 *
 * Feed titles are attacker-influenced if the blog is ever compromised.
 * They get written into a file this workflow commits, so they are
 * treated as hostile: tags stripped, entities decoded once, markdown
 * control characters escaped, length capped.
 * ------------------------------------------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (Object.prototype.hasOwnProperty.call(ENTITIES, e)) return ENTITIES[e];
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return '';
  });
}

function text(raw, max = 110) {
  let s = String(raw ?? '');
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '...';
  return s.replace(/([\\`*_[\]()<>|#])/g, '\\$1');
}

// Medium appends ?source=rss-<id>------2 to every link in its feed; other
// platforms add utm_*. None of it belongs in a README.
const STRIP_PARAMS = new Set([
  'source', 'ref', 'referrer',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
]);

function safeUrl(raw) {
  try {
    const u = new URL(decodeEntities(String(raw ?? '').trim()));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    for (const p of [...u.searchParams.keys()]) {
      if (STRIP_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
    }
    return u.href.replace(/[()\s]/g, (c) => encodeURIComponent(c));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Minimal RSS / Atom reader
 * ------------------------------------------------------------------ */

function blocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1]);
}

function child(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}

function atomLink(block) {
  const alt = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  if (alt) return alt[1];
  const any = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  return any ? any[1] : '';
}

async function getBlogPosts() {
  // Pinned blog: if pinBlog.url is set, render it standalone without
  // touching the feed at all. Useful when the post you want to feature
  // is older than the feed's retention window. The title, url, and date
  // are taken directly from config so the user is the source of truth.
  const pin = cfg.pinBlog;
  if (pin && pin.url) {
    const dateStr = pin.date ? ` <sub>${pin.date}</sub>` : '';
    const title = pin.title || pin.url;
    return `- [${text(title)}](${safeUrl(pin.url)})${dateStr}`;
  }
  if (!FEED) return null;
  const res = await fetch(FEED, { headers: { 'User-Agent': UA['User-Agent'] }, redirect: 'follow' });
  if (!res.ok) throw new Error(`feed ${FEED} -> HTTP ${res.status}`);
  const xml = await res.text();

  const isAtom = /<feed\b[^>]*xmlns=["'][^"']*Atom/i.test(xml) || /<entry\b/i.test(xml);
  const raw = isAtom ? blocks(xml, 'entry') : blocks(xml, 'item');

  const posts = [];
  for (const b of raw) {
    const title = text(child(b, 'title'));
    const url = safeUrl(isAtom ? atomLink(b) : child(b, 'link'));
    if (!title || !url) continue;
    const when = child(b, 'pubDate') || child(b, 'updated') || child(b, 'published') || '';
    const d = new Date(decodeEntities(when).trim());
    posts.push({ title, url, date: Number.isNaN(d.getTime()) ? null : d });
  }

  posts.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  const top = posts.slice(0, cfg.blog.count);
  if (!top.length) return '_No posts found in feed._';

  return top
    .map((p) => {
      const stamp = cfg.blog.showDate && p.date ? ` <sub>${p.date.toISOString().slice(0, 10)}</sub>` : '';
      return `- [${p.title}](${p.url})${stamp}`;
    })
    .join('\n');
}

/* ------------------------------------------------------------------ *
 * Marker replacement
 * ------------------------------------------------------------------ */

function replaceSection(doc, name, body) {
  const re = new RegExp(
    `(<!--\\s*${name}:start\\s*-->)([\\s\\S]*?)(<!--\\s*${name}:end\\s*-->)`,
    'i'
  );
  if (!re.test(doc)) throw new Error(`markers for "${name}" not found in README.md`);
  return doc.replace(re, (_m, open, _old, close) => `${open}\n${body}\n${close}`);
}

/* ------------------------------------------------------------------ */

let doc = await readFile(README, 'utf8');
const before = doc;
const failures = [];

try {
  const body = await getBlogPosts();
  if (body === null) {
    console.log('skip  blog-posts (not configured)');
  } else {
    doc = replaceSection(doc, 'blog-posts', body);
    console.log('ok    blog-posts');
  }
} catch (err) {
  failures.push(`blog-posts: ${err.message}`);
  console.error(`FAIL  blog-posts: ${err.message}`);
}

if (doc !== before) {
  await writeFile(README, doc);
  console.log('README.md updated');
} else {
  console.log('no changes');
}

// A dead feed should not silently rot the README into staleness.
if (failures.length) {
  console.error(`\n${failures.length} section(s) failed`);
  process.exit(1);
}
