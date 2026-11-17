// build-releases.js
// Fetches the latest releases from the GitHub API and bakes the release list
// into the demo site index.html so each page build workflow run publishes an
// up-to-date list without relying on a client-side fetch.
//
// Usage: node build-releases.js [path/to/index.html]
//   Env overrides: INDEX_HTML_PATH, GH_TOKEN (optional, raises rate limit)
import { readFileSync, writeFileSync } from 'fs';

const REPO = 'brgjr10/kaleidosync';
const DEFAULT_INDEX = 'index.html';
const LIMIT = 8;

const INDEX_PATH = process.argv[2] || process.env.INDEX_HTML_PATH || DEFAULT_INDEX;
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

/**
 * Sanitize HTML string to prevent injection - only allow safe characters
 * This is a defense-in-depth measure for the build script writing API data to file
 */
function sanitizeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>]/g, '')
    .replace(/["']/g, '')
    .replace(/(?:java|vb)script:/gi, '')
    .replace(/data:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .slice(0, 500);
}

/**
 * Validate and sanitize release data from GitHub API
 */
function validateReleases(releases) {
  if (!Array.isArray(releases)) return [];
  return releases.slice(0, LIMIT).map(r => ({
    html_url: sanitizeHtml(r.html_url),
    tag_name: sanitizeHtml(r.tag_name),
    name: sanitizeHtml(r.name),
    published_at: sanitizeHtml(r.published_at),
    created_at: sanitizeHtml(r.created_at)
  })).filter(r => r.html_url && r.tag_name);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function buildList(releases) {
  return releases.slice(0, LIMIT).map(r => {
    const date = fmtDate(r.published_at);
    return `<li><a href="${r.html_url}" target="_blank" rel="noopener">${r.tag_name || r.name}</a> <span>${r.name || ''} · ${date}</span></li>`;
  }).join('');
}

function buildNote(releases) {
  if (!releases.length) return 'No releases found.';
  return `${releases.length} releases · latest: ${releases[0].tag_name || releases[0].name}`;
}

async function main() {
  let releases = [];
  try {
    const headers = { Accept: 'application/vnd.github+json' };
    if (GH_TOKEN) headers.Authorization = `token ${GH_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const rawReleases = await res.json();
    releases = validateReleases(rawReleases);
  } catch (e) {
    process.stderr.write(`build-releases: fetch failed (${e.message}); leaving existing list intact\n`);
    process.exit(0);
  }

  if (!releases.length) {
    process.stderr.write('build-releases: no valid releases returned; leaving existing list intact\n');
    process.exit(0);
  }

  releases.sort((a, b) => new Date(b.published_at || b.created_at || 0) - new Date(a.published_at || a.created_at || 0));

  const listHtml = buildList(releases);
  const noteText = buildNote(releases);

  let src;
  try {
    src = readFileSync(INDEX_PATH, 'utf8');
  } catch (e) {
    process.stderr.write(`build-releases: cannot read ${INDEX_PATH}: ${e.message}\n`);
    process.exit(1);
  }

  // Replace the inner contents of <ul id="release-list">...</ul>
  const listRegex = /(<ul id="release-list">)[\s\S]*?(<\/ul>)/;
  if (!listRegex.test(src)) {
    process.stderr.write(`build-releases: <ul id="release-list"> not found in ${INDEX_PATH}\n`);
    process.exit(1);
  }
  src = src.replace(listRegex, `$1\n${listHtml}\n$2`);

  // Replace the #release-note paragraph text
  const noteRegex = /(<p id="release-note"[^>]*>)[\s\S]*?(<\/p>)/;
  if (!noteRegex.test(src)) {
    process.stderr.write(`build-releases: <p id="release-note"> not found in ${INDEX_PATH}\n`);
    process.exit(1);
  }
  src = src.replace(noteRegex, `$1${noteText}$2`);

  writeFileSync(INDEX_PATH, src, 'utf8');
  process.stdout.write(`build-releases: baked ${releases.length} releases into ${INDEX_PATH}\n`);
}

main().catch(e => {
  process.stderr.write(`build-releases: error: ${e.message}\n`);
  process.exit(1);
});
