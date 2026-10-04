#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @typedef {string & { readonly __brand: 'CaptureId' }} CaptureId
 * @typedef {string & { readonly __brand: 'AssetId' }} AssetId
 * @typedef {string & { readonly __brand: 'Sha256' }} Sha256
 * @typedef {string & { readonly __brand: 'AbsPath' }} AbsPath
 */

/**
 * @typedef {(
 *   | { kind: 'script-src', url: string, module: boolean }
 *   | { kind: 'preload', url: string }
 *   | { kind: 'import', url: string, from: AssetId }
 *   | { kind: 'inline', index: number, module: boolean }
 *   | { kind: 'document', url: string }
 *   | { kind: 'local', path: AbsPath }
 * )} AssetSource
 */

/** @typedef {'first-party' | 'third-party'} Party */

/**
 * @typedef {object} FetchFailure
 * @property {string} url
 * @property {AssetSource['kind']} via
 * @property {'http' | 'redirect' | 'size-limit' | 'network' | 'timeout'} reason
 * @property {string} detail
 */

/**
 * @typedef {(
 *   | { kind: 'runtime-chunks', assetId: AssetId, evidence: string }
 *   | { kind: 'client-rendered-shell', evidence: string }
 *   | { kind: 'no-scripts' }
 *   | { kind: 'asset-cap', dropped: string[] }
 * )} Gap
 */

/**
 * @typedef {(
 *   | { kind: 'ready', raw: AbsPath, preprocessedFile: AbsPath, analysis: AbsPath,
 *       modulesDir: AbsPath | null, deminifiedDir: AbsPath }
 *   | { kind: 'skipped', raw: AbsPath, reason: 'too-small' }
 *   | { kind: 'preprocess-failed', raw: AbsPath, exitCode: number, log: AbsPath }
 * )} AssetStatus
 */

/**
 * @typedef {object} AssetEntry
 * @property {AssetId} id
 * @property {Sha256} sha256
 * @property {number} bytes
 * @property {Party} party
 * @property {AssetSource[]} sources
 * @property {string | null} sourceMapUrl
 * @property {AssetStatus} status
 */

/**
 * @typedef {object} Capture
 * @property {1} version
 * @property {CaptureId} id
 * @property {string} target
 * @property {string} finalUrl
 * @property {string} capturedAt
 * @property {AbsPath} root
 * @property {AssetEntry[]} assets
 * @property {FetchFailure[]} failures
 * @property {Gap[]} gaps
 */

const POLICY = Object.freeze({
  maxAssets: 60,
  maxAssetBytes: 20 * 1024 * 1024,
  maxImportDepth: 3,
  maxRedirects: 10,
  fetchConcurrency: 6,
  fetchTimeoutMs: 30_000,
  minProcessBytes: 1024,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
});

const JS_MIME = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

const SKIP_ANCESTORS = new Set(['template', 'noscript', 'frameset']);

const RUNTIME_MARKERS = [
  ['__webpack_require__.u', /__webpack_require__\s*\.\s*u\b/],
  ['webpackChunk', /\bwebpackChunk\b/],
  ['__turbopack_load__', /__turbopack_load__\b/],
];

const USAGE = 'Usage: node capture.mjs <url-or-path> [--out <dir>] [--no-format]';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_ROOT = resolve(SKILL_DIR, '../../../output');
const PREPROCESS = resolve(SKILL_DIR, 'preprocess.mjs');

async function main(argv) {
  const inv = parseInvocation(argv);
  const snap = await acquire(inv.target, inv.given);
  const root = resolve(inv.outRoot, snap.captureId);
  persistRaw(root, snap);
  const outcomes = await preprocessAll(root, snap.assets, inv.format);
  const capture = buildCapture(root, snap, outcomes, new Date());
  writeManifest(capture);
  process.stdout.write(renderSummary(capture));
  return capture.assets.some((asset) => asset.status.kind === 'ready') ? 0 : 2;
}

function parseInvocation(argv) {
  let outRoot = null;
  let format = true;
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-format') {
      format = false;
      continue;
    }
    if (arg === '--out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${USAGE}\n--out requires a directory`);
      outRoot = resolve(value);
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}\n${USAGE}`);
    positionals.push(arg);
  }
  if (positionals.length !== 1) throw new Error(USAGE);
  const given = positionals[0];
  return {
    target: parseTarget(given),
    given,
    outRoot: outRoot || DEFAULT_OUT_ROOT,
    format,
  };
}

function parseTarget(given) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(given)) {
    let url;
    try {
      url = new URL(given);
    } catch (err) {
      throw new Error(`Invalid URL: ${err.message}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Unsupported URL scheme ${url.protocol}`);
    }
    if (url.username || url.password) {
      throw new Error('URLs with a username or password are not allowed');
    }
    return { kind: 'remote', url };
  }
  const path = resolve(given);
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  return { kind: 'local', path };
}

async function acquire(target, given) {
  if (target.kind === 'local') return acquireLocal(target, given);
  return acquireRemote(target, given);
}

function acquireLocal(target, given) {
  const text = readFileSync(target.path, 'utf8').replace(/^\uFEFF/, '');
  const source = { kind: 'local', path: target.path };
  const assets = [];
  adopt(assets, text, source, 'first-party');
  return {
    target,
    given,
    captureId: captureIdFor(target),
    finalUrl: pathToFileURL(target.path).href,
    html: null,
    assets,
    failures: [],
    gaps: detectGaps(null, assets),
  };
}

async function acquireRemote(target, given) {
  const page = await fetchBody(target.url.href);
  if (!page.ok) throw new Error(`${page.reason}: ${page.detail}`);
  const text = decodeBody(page.body);
  const finalUrl = page.finalUrl;
  const origin = new URL(finalUrl).origin;
  const assets = [];
  const failures = [];
  const dropped = [];
  const visited = new Set([stripHash(finalUrl), stripHash(target.url.href)]);
  const budget = { reserved: 0 };

  if (!isHtmlDocument(page.contentType, text)) {
    const asset = takeAsset(assets, dropped, budget, text, { kind: 'document', url: finalUrl }, 'first-party');
    const queue = [];
    if (asset) enqueueImports(queue, visited, assets, dropped, budget, asset, finalUrl, 0, origin);
    await drain(queue, { assets, failures, dropped, visited, origin, budget });
    return finishRemote(target, given, finalUrl, null, assets, failures, dropped);
  }

  const refs = discoverScripts(text, finalUrl);
    const queue = [];
  for (const ref of refs) {
    if (ref.kind === 'inline') {
      const source = { kind: 'inline', index: ref.index, module: ref.module };
      const asset = takeAsset(assets, dropped, budget, ref.text, source, 'first-party');
      if (asset) queue.push({ kind: 'scan', asset, assetUrl: finalUrl, depth: 0 });
      continue;
    }
    enqueueFetch(queue, visited, assets, dropped, budget, {
      kind: 'fetch',
      url: ref.url,
      via: ref.via,
      module: ref.module,
      depth: 0,
      from: null,
    });
  }
  await drain(queue, { assets, failures, dropped, visited, origin, budget });
  return finishRemote(target, given, finalUrl, text, assets, failures, dropped);
}

function finishRemote(target, given, finalUrl, html, assets, failures, dropped) {
  const gaps = detectGaps(html, assets);
  if (dropped.length > 0) gaps.push({ kind: 'asset-cap', dropped });
  return {
    target,
    given,
    captureId: captureIdFor(target),
    finalUrl,
    html,
    assets,
    failures,
    gaps,
  };
}

function persistRaw(root, snap) {
  mkdirSync(join(root, 'raw'), { recursive: true });
  if (snap.html != null) atomicWrite(join(root, 'page.html'), snap.html);
  for (const asset of snap.assets) {
    atomicWrite(layout(root, asset.id).raw, asset.text);
  }
}

async function preprocessAll(root, assets, format) {
    const outcomes = new Map();
  const pending = assets.filter((asset) => asset.decision.kind === 'process');
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const asset = pending[cursor++];
      outcomes.set(asset.id, await preprocessOne(root, asset, format));
    }
  }
  const workers = [];
  const n = Math.min(POLICY.fetchConcurrency, pending.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return outcomes;
}

async function preprocessOne(root, asset, format) {
  const paths = layout(root, asset.id);
  const reused = reusePreprocess(paths);
  if (reused) return reused;
  const partial = `${paths.preprocessedDir}.partial-${process.pid}`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  const outcome = await runPreprocess(paths.raw, partial, format);
  if (outcome.kind === 'ok') {
    promotePartial(partial, paths.preprocessedDir);
    return reusePreprocess(paths);
  }
  mkdirSync(paths.preprocessedDir, { recursive: true });
  writeFileSync(paths.log, outcome.log);
  rmSync(partial, { recursive: true, force: true });
  return { kind: 'failed', exitCode: outcome.exitCode };
}

function reusePreprocess(paths) {
  if (!existsSync(paths.analysis)) return null;
  return { kind: 'ok', modulesDir: existsSync(paths.modulesDir) ? paths.modulesDir : null };
}

function runPreprocess(raw, partial, format) {
  const args = [PREPROCESS, raw, '--outdir', partial, '--split'];
  if (!format) args.push('--no-format');
  return new Promise((resolveOutcome) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    const logText = () => Buffer.concat(chunks).toString('utf8');
    child.on('error', (err) => {
      chunks.push(Buffer.from(String(err)));
      resolveOutcome({ kind: 'failed', exitCode: 1, log: logText() });
    });
    child.on('close', (code) => {
      const log = logText();
      if (code === 0) {
        writeFileSync(join(partial, '_preprocess.log'), log);
        resolveOutcome({ kind: 'ok', modulesDir: null });
        return;
      }
      resolveOutcome({ kind: 'failed', exitCode: code ?? 1, log });
    });
  });
}

function promotePartial(partial, finalDir) {
  if (existsSync(join(finalDir, '_analysis.txt'))) {
    rmSync(partial, { recursive: true, force: true });
    return;
  }
  mkdirSync(dirname(finalDir), { recursive: true });
  if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
  renameSync(partial, finalDir);
}

function writeManifest(capture) {
  atomicWrite(join(capture.root, 'capture.json'), JSON.stringify(capture, null, 2) + '\n');
}

function atomicWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function fetchBody(url, redirectsLeft = POLICY.maxRedirects) {
  return new Promise((resolveResult) => {
    let settled = false;
        const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      finish({ ok: false, reason: 'network', detail: err.message });
      return;
    }
    if (parsed.username || parsed.password) {
      finish({ ok: false, reason: 'redirect', detail: 'URL contains a username or password' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      finish({ ok: false, reason: 'network', detail: `unsupported protocol ${parsed.protocol}` });
      return;
    }
    const request = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(parsed, {
      method: 'GET',
      headers: { 'user-agent': POLICY.userAgent, accept: '*/*' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        res.resume();
        if (!location) {
          finish({ ok: false, reason: 'redirect', detail: `HTTP ${status} without Location` });
          return;
        }
        if (redirectsLeft <= 0) {
          finish({ ok: false, reason: 'redirect', detail: `stopped after ${POLICY.maxRedirects} redirects` });
          return;
        }
        let next;
        try {
          next = new URL(location, parsed);
        } catch (err) {
          finish({ ok: false, reason: 'redirect', detail: err.message });
          return;
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          finish({ ok: false, reason: 'redirect', detail: `redirect to ${next.protocol}` });
          return;
        }
        fetchBody(next.href, redirectsLeft - 1).then(finish);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        finish({ ok: false, reason: 'http', detail: `HTTP ${status}` });
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > POLICY.maxAssetBytes) {
        res.resume();
        finish({
          ok: false,
          reason: 'size-limit',
          detail: `content-length ${declared} exceeds ${POLICY.maxAssetBytes} bytes`,
        });
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > POLICY.maxAssetBytes) {
          req.destroy();
          finish({
            ok: false,
            reason: 'size-limit',
            detail: `body exceeds ${POLICY.maxAssetBytes} bytes`,
          });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        finish({
          ok: true,
          finalUrl: parsed.href,
          contentType: String(res.headers['content-type'] || ''),
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', (err) => finish({ ok: false, reason: 'network', detail: err.message }));
    });
    req.setTimeout(POLICY.fetchTimeoutMs, () => {
      req.destroy();
      finish({ ok: false, reason: 'timeout', detail: `timed out after ${POLICY.fetchTimeoutMs}ms` });
    });
    req.on('error', (err) => finish({ ok: false, reason: 'network', detail: err.message }));
    req.end();
  });
}

function decodeBody(body) {
  const text = body.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isHtmlDocument(contentType, text) {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime.includes('javascript') || mime.includes('ecmascript')) return false;
  return text.trimStart().startsWith('<');
}

function adopt(assets, text, source, party) {
  const sha256 = createHash('sha256').update(text).digest('hex');
  const existing = assets.find((asset) => asset.sha256 === sha256);
  if (existing) {
    if (!existing.sources.some((item) => sameSource(item, source))) existing.sources.push(source);
    return existing;
  }
    const asset = {
    id: assetIdFor(source, sha256),
    sha256,
    text,
    sources: [source],
    party,
    decision: decide(text),
    sourceMapUrl: readSourceMapUrl(text),
  };
  assets.push(asset);
  return asset;
}

function hasRoom(assets, budget) {
  return assets.length + budget.reserved < POLICY.maxAssets;
}

function takeAsset(assets, dropped, budget, text, source, party) {
  const sha256 = createHash('sha256').update(text).digest('hex');
  if (!assets.some((asset) => asset.sha256 === sha256) && !hasRoom(assets, budget)) {
    dropped.push(sourceLabel(source));
    return null;
  }
  return adopt(assets, text, source, party);
}

function enqueueFetch(queue, visited, assets, dropped, budget, job) {
  const key = stripHash(job.url);
  if (visited.has(key)) return;
  if (!hasRoom(assets, budget)) {
    dropped.push(job.url);
    return;
  }
  visited.add(key);
  budget.reserved++;
  queue.push(job);
}

function enqueueImports(queue, visited, assets, dropped, budget, asset, assetUrl, depth, origin) {
  if (depth >= POLICY.maxImportDepth) return;
  for (const url of discoverImports(asset.text, assetUrl, origin)) {
    enqueueFetch(queue, visited, assets, dropped, budget, {
      kind: 'fetch',
      url,
      via: 'import',
      module: true,
      depth: depth + 1,
      from: asset.id,
    });
  }
}

async function drain(queue, ctx) {
  let cursor = 0;
  let active = 0;
  await new Promise((resolveDrain) => {
    const kick = () => {
      if (cursor >= queue.length && active === 0) {
        resolveDrain();
        return;
      }
      while (active < POLICY.fetchConcurrency && cursor < queue.length) {
        const job = queue[cursor++];
        active++;
        runJob(job, queue, ctx)
          .catch((err) => {
            if (job.kind === 'fetch') {
              ctx.failures.push({
                url: job.url,
                via: job.via,
                reason: 'network',
                detail: err.message,
              });
            }
          })
          .finally(() => {
            active--;
            kick();
          });
      }
    };
    kick();
  });
}

async function runJob(job, queue, ctx) {
  if (job.kind === 'scan') {
    enqueueImports(
      queue, ctx.visited, ctx.assets, ctx.dropped, ctx.budget,
      job.asset, job.assetUrl, job.depth, ctx.origin,
    );
    return;
  }
  let open = true;
  const release = () => {
    if (!open) return;
    open = false;
    ctx.budget.reserved--;
  };
  try {
    const result = await fetchBody(job.url);
    if (!result.ok) {
      ctx.failures.push({ url: job.url, via: job.via, reason: result.reason, detail: result.detail });
      return;
    }
    const text = decodeBody(result.body);
    const source = sourceFromJob(job);
    const party = new URL(job.url).origin === ctx.origin ? 'first-party' : 'third-party';
    const asset = adopt(ctx.assets, text, source, party);
    release();
    enqueueImports(
      queue, ctx.visited, ctx.assets, ctx.dropped, ctx.budget,
      asset, job.url, job.depth, ctx.origin,
    );
  } finally {
    release();
  }
}

function sourceFromJob(job) {
  if (job.via === 'import') return { kind: 'import', url: job.url, from: job.from };
  if (job.via === 'preload') return { kind: 'preload', url: job.url };
  return { kind: 'script-src', url: job.url, module: job.module };
}

function normalizeTarget(target) {
  if (target.kind === 'local') return target.path;
  const url = new URL(target.url.href);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  return url.href;
}

function captureIdFor(target) {
  const norm = normalizeTarget(target);
  const hash = createHash('sha256').update(norm).digest('hex').slice(0, 6);
  if (target.kind === 'local') {
    return `local_${slug(basename(target.path))}_${hash}`;
  }
  const url = new URL(norm);
  const path = slug(url.pathname.replace(/^\//, '')).slice(0, 48) || 'root';
  return `${slug(url.hostname)}_${path}_${hash}`;
}

function slug(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

function discoverScripts(html, documentUrl) {
    const refs = [];
  let inlineIndex = 0;
  let baseUrl = documentUrl;
  let sawBase = false;
  let skip = 0;
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[i] !== '<') {
      i++;
      continue;
    }
    const tag = readTag(html, i);
    if (!tag) {
      i++;
      continue;
    }
    if (tag.name === 'script' && !tag.closing) {
      const closeAt = findScriptEnd(html, tag.end);
      if (skip === 0) {
        const ref = scriptRef(tag.attrs, html.slice(tag.end, closeAt), baseUrl, inlineIndex);
        if (ref) {
          if (ref.kind === 'inline') inlineIndex++;
          refs.push(ref);
        }
      }
      i = closeAt === html.length ? html.length : indexAfterScriptClose(html, closeAt);
      continue;
    }
    if (SKIP_ANCESTORS.has(tag.name)) {
      if (tag.closing) skip = Math.max(0, skip - 1);
      else if (!tag.selfClosing) skip++;
    } else if (skip === 0 && !tag.closing) {
      if (tag.name === 'base' && !sawBase) {
        const href = attr(tag.attrs, 'href');
        if (href) {
          try {
            baseUrl = new URL(href, documentUrl).href;
            sawBase = true;
            } catch {
              baseUrl = documentUrl;
            }
        }
      } else if (tag.name === 'link') {
        const ref = linkRef(tag.attrs, baseUrl);
        if (ref) refs.push(ref);
      }
    }
    i = tag.end;
  }
  return refs;
}

function scriptRef(attrs, body, baseUrl, inlineIndex) {
  if (!isExecutableType(attr(attrs, 'type'))) return null;
  const module = (attr(attrs, 'type') || '').trim().toLowerCase() === 'module';
  const src = attr(attrs, 'src');
  if (src == null) {
    if (body.length === 0) return null;
    return { kind: 'inline', index: inlineIndex, text: body, module };
  }
  const classified = classifyScriptUrl(src, baseUrl);
  if (classified.kind === 'ignore') return null;
  if (classified.kind === 'inline') {
    return { kind: 'inline', index: inlineIndex, text: classified.text, module };
  }
  return { kind: 'external', url: classified.url, via: 'script-src', module };
}

function linkRef(attrs, baseUrl) {
  const rel = (attr(attrs, 'rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const as = (attr(attrs, 'as') || '').toLowerCase();
  const preload = rel.includes('modulepreload') || (rel.includes('preload') && as === 'script');
  if (!preload) return null;
  const href = attr(attrs, 'href');
  if (!href) return null;
  const classified = classifyScriptUrl(href, baseUrl);
  if (classified.kind !== 'external') return null;
  return { kind: 'external', url: classified.url, via: 'preload', module: rel.includes('modulepreload') };
}

function isExecutableType(type) {
  if (type == null) return true;
  const trimmed = type.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'module') return true;
  return JS_MIME.has(trimmed.split(';')[0].trim());
}

function classifyScriptUrl(src, baseUrl) {
  const trimmed = src.trim();
  if (/^javascript:/i.test(trimmed) || /^blob:/i.test(trimmed)) return { kind: 'ignore' };
  const data = decodeDataScript(trimmed);
  if (data != null) return { kind: 'inline', text: data };
  if (/^data:/i.test(trimmed)) return { kind: 'ignore' };
  let url;
  try {
    url = new URL(trimmed, baseUrl);
  } catch {
    return { kind: 'ignore' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'ignore' };
  if (url.username || url.password) return { kind: 'ignore' };
  url.hash = '';
  return { kind: 'external', url: url.href };
}

function decodeDataScript(src) {
  const match = /^data:((?:text|application)\/javascript)((?:;[^,]*)*),([\s\S]*)$/i.exec(src.trim());
  if (!match) return null;
  const params = match[2] || '';
  const data = match[3];
  if (/base64/i.test(params)) return Buffer.from(data, 'base64').toString('utf8');
  try {
    return decodeURIComponent(data.replace(/\+/g, ' '));
  } catch {
    return data;
  }
}

function readTag(html, i) {
  const closing = html[i + 1] === '/';
  const nameStart = closing ? i + 2 : i + 1;
  const nameMatch = /^([a-zA-Z][\w:-]*)/.exec(html.slice(nameStart));
  if (!nameMatch) return null;
  const name = nameMatch[1].toLowerCase();
  let k = nameStart + name.length;
  let quote = '';
  for (; k < html.length; k++) {
    const ch = html[k];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') break;
  }
  if (k >= html.length) return null;
  const attrs = html.slice(nameStart + name.length, k);
  return { name, closing, selfClosing: /\/\s*$/.test(attrs), attrs, end: k + 1 };
}

function findScriptEnd(html, from) {
  const lower = html.slice(from).toLowerCase();
  const at = lower.indexOf('</script');
  return at === -1 ? html.length : from + at;
}

function indexAfterScriptClose(html, closeAt) {
  const end = html.indexOf('>', closeAt);
  return end === -1 ? html.length : end + 1;
}

function attr(raw, key) {
  const re = new RegExp(
    `(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\\`]+))`,
    'i',
  );
  const match = re.exec(raw);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? '';
}

const IMPORT_PATTERNS = [
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bexport\s+[^'"\n;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*(?:[^'"\n;]*?\bfrom\s*)?['"]([^'"]+)['"]/g,
];

function discoverImports(code, assetUrl, documentOrigin) {
    const found = [];
  const seen = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const spec = match[1];
      if (!/^(?:\.|\/|https?:\/\/|\/\/)/.test(spec)) continue;
      let url;
      try {
        url = new URL(spec, assetUrl);
      } catch {
        continue;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (url.origin !== documentOrigin) continue;
      url.hash = '';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      found.push(url.href);
    }
  }
  return found;
}

function assetIdFor(source, sha256) {
  return `${stemFor(source)}-${sha256.slice(0, 8)}`;
}

function stemFor(source) {
  if (source.kind === 'inline') return `inline-${source.index}`;
  if (source.kind === 'local') return safeStem(basename(source.path, extname(source.path)));
  let base;
  try {
    base = basename(new URL(source.url).pathname);
  } catch {
    base = 'script';
  }
  return safeStem(base.replace(/\.[^.]+$/, ''));
}

function safeStem(value) {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '').replace(/^\.+/, '');
  return (cleaned || 'script').slice(0, 40);
}

function decide(text) {
  if (Buffer.byteLength(text) < POLICY.minProcessBytes) return { kind: 'skip', reason: 'too-small' };
  return { kind: 'process' };
}

function detectGaps(html, assets) {
    const gaps = [];
  if (html != null && assets.length === 0) gaps.push({ kind: 'no-scripts' });
  if (html != null) {
    const shell = clientShell(html);
    if (shell) gaps.push({ kind: 'client-rendered-shell', evidence: shell });
  }
  for (const asset of assets) {
    for (const [name, pattern] of RUNTIME_MARKERS) {
      if (pattern.test(asset.text)) {
        gaps.push({
          kind: 'runtime-chunks',
          assetId: asset.id,
          evidence: `${name} loads chunk URLs at runtime`,
        });
        break;
      }
    }
  }
  return gaps;
}

function clientShell(html) {
  const mount = html.match(/\bid\s*=\s*["'](root|app|__next)["']/i);
  if (!mount) return null;
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const inner = body ? body[1] : html;
  const text = inner
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 80) return null;
  return `mount node #${mount[1]} with no body text`;
}

function readSourceMapUrl(text) {
  const match = text.match(/[@#]\s*sourceMappingURL=(\S+)\s*(?:\*\/)?\s*$/);
  return match ? match[1] : null;
}

function layout(root, id) {
  const preprocessedDir = resolve(root, 'preprocessed', id);
  return {
    raw: resolve(root, 'raw', `${id}.js`),
    preprocessedDir,
    preprocessedFile: resolve(preprocessedDir, `${id}.js`),
    analysis: resolve(preprocessedDir, '_analysis.txt'),
    log: resolve(preprocessedDir, '_preprocess.log'),
    modulesDir: resolve(preprocessedDir, 'modules'),
    deminifiedDir: resolve(root, 'src', id),
  };
}

function buildCapture(root, snap, outcomes, now) {
    const assets = snap.assets.map((asset) => ({
    id: asset.id,
    sha256: asset.sha256,
    bytes: Buffer.byteLength(asset.text),
    party: asset.party,
    sources: asset.sources,
    sourceMapUrl: asset.sourceMapUrl,
    status: statusFor(root, asset, outcomes.get(asset.id)),
  }));
  assets.sort((a, b) => {
    const rank = statusRank(a.status.kind) - statusRank(b.status.kind);
    if (rank !== 0) return rank;
    const party = (a.party === 'first-party' ? 0 : 1) - (b.party === 'first-party' ? 0 : 1);
    if (party !== 0) return party;
    return b.bytes - a.bytes;
  });
  return {
    version: 1,
    id: snap.captureId,
    target: snap.given,
    finalUrl: snap.finalUrl,
    capturedAt: now.toISOString(),
    root,
    assets,
    failures: snap.failures,
    gaps: snap.gaps,
  };
}

function statusRank(kind) {
  if (kind === 'ready') return 0;
  if (kind === 'skipped') return 1;
  return 2;
}

function statusFor(root, asset, outcome) {
  const paths = layout(root, asset.id);
  if (asset.decision.kind === 'skip') {
    return { kind: 'skipped', raw: paths.raw, reason: asset.decision.reason };
  }
  if (!outcome || outcome.kind === 'failed') {
    return {
      kind: 'preprocess-failed',
      raw: paths.raw,
      exitCode: outcome && outcome.kind === 'failed' ? outcome.exitCode : 1,
      log: paths.log,
    };
  }
  return {
    kind: 'ready',
    raw: paths.raw,
    preprocessedFile: paths.preprocessedFile,
    analysis: paths.analysis,
    modulesDir: outcome.modulesDir,
    deminifiedDir: paths.deminifiedDir,
  };
}

function renderSummary(capture) {
  const lines = [`Capture ${capture.id}`, `Manifest ${join(capture.root, 'capture.json')}`];
  for (const asset of capture.assets) {
    const source = asset.sources[0];
    lines.push(
      `  ${asset.status.kind.padEnd(18)} ${asset.id.padEnd(28)} ${formatBytes(asset.bytes).padStart(10)}  ${asset.party.padEnd(12)} ${source.kind.padEnd(11)} ${summaryLocator(asset)}`,
    );
  }
  if (capture.failures.length > 0) {
    lines.push('Failures');
    for (const failure of capture.failures) {
      lines.push(`  ${failure.reason.padEnd(12)} ${failure.via.padEnd(12)} ${failure.url}  ${failure.detail}`);
    }
  }
  if (capture.gaps.length > 0) {
    lines.push('Gaps');
    for (const gap of capture.gaps) {
      if (gap.kind === 'runtime-chunks') lines.push(`  runtime-chunks  ${gap.assetId}  ${gap.evidence}`);
      else if (gap.kind === 'asset-cap') lines.push(`  asset-cap  dropped ${gap.dropped.length}`);
      else if (gap.kind === 'client-rendered-shell') lines.push(`  client-rendered-shell  ${gap.evidence}`);
      else lines.push(`  ${gap.kind}`);
    }
  }
  return lines.join('\n') + '\n';
}

function summaryLocator(asset) {
  if (asset.status.kind === 'skipped') return asset.status.reason;
  const source = asset.sources[0];
  if (source.kind === 'inline') return 'inline';
  if (source.kind === 'local') return source.path;
  try {
    const url = new URL(source.url);
    if (asset.party === 'third-party') return source.url;
    return url.pathname + url.search;
  } catch {
    return source.url;
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function sourceLabel(source) {
  if (source.kind === 'inline') return `inline-${source.index}`;
  if (source.kind === 'local') return source.path;
  return source.url;
}

function sameSource(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stripHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
