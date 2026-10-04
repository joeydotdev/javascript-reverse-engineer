#!/usr/bin/env node

/**
 * @fileoverview Test runner for deminify skill scripts.
 *
 * Usage:
 *   node tests/run.mjs                  # Run all tests
 *   node tests/run.mjs --filter jsx     # Run tests matching "jsx"
 *   node tests/run.mjs --verbose        # Show full output on failure
 *
 * Tests are organized into suites. Each test defines an input, runs a script,
 * and asserts properties of the output. Assertions are simple string/regex
 * checks — no test framework needed.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_DIR = resolve(__dirname, '..');
const FIXTURES_DIR = join(__dirname, 'fixtures');
const TMP_DIR = join(__dirname, '.tmp');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const filter = (() => {
  const idx = args.indexOf('--filter');
  return idx !== -1 ? args[idx + 1] : null;
})();
const verbose = args.includes('--verbose');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function cleanTmp() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
}

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(message + (details && verbose ? '\n' + details : ''));
  }
}

function assertContains(haystack, needle, label) {
  assert(
    haystack.includes(needle),
    `${label}: expected output to contain "${needle}"`,
    `Actual output:\n${haystack.slice(0, 500)}`,
  );
}

function assertNotContains(haystack, needle, label) {
  assert(
    !haystack.includes(needle),
    `${label}: expected output NOT to contain "${needle}"`,
    `Actual output:\n${haystack.slice(0, 500)}`,
  );
}

function assertMatch(haystack, regex, label) {
  assert(
    regex.test(haystack),
    `${label}: expected output to match ${regex}`,
    `Actual output:\n${haystack.slice(0, 500)}`,
  );
}

let chain = Promise.resolve();

function runTest(name, fn) {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) {
    skipped++;
    return;
  }

  chain = chain.then(async () => {
    try {
      cleanTmp();
      await fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
      failed++;
      failures.push({ name, error: err.message });
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      if (verbose) {
        console.log(`    ${err.message}`);
      }
    }
  });
}

function suite(name, fn) {
  chain = chain.then(() => {
    console.log(`\n\x1b[1m${name}\x1b[0m`);
  });
  fn();
}

// ---------------------------------------------------------------------------
// Helper: run script and return stdout
// ---------------------------------------------------------------------------

function runPreprocess(inputFile, extraArgs = '') {
  const outdir = join(TMP_DIR, 'preprocess-out');
  const cmd = `node ${join(SKILL_DIR, 'preprocess.mjs')} "${inputFile}" --outdir "${outdir}" --no-format ${extraArgs}`;
  const stdout = execSync(cmd, { encoding: 'utf-8', cwd: SKILL_DIR, timeout: 30_000 });
  return { stdout, outdir };
}

function runJsxRestore(inputFile) {
  const outdir = join(TMP_DIR, 'jsx-out');
  mkdirSync(outdir, { recursive: true });
  const cmd = `node ${join(SKILL_DIR, 'jsx-restore.mjs')} "${inputFile}" --outdir "${outdir}"`;
  const stdout = execSync(cmd, { encoding: 'utf-8', cwd: SKILL_DIR, timeout: 60_000 });
  return { stdout, outdir };
}

function readFixture(subdir, name) {
  return readFileSync(join(FIXTURES_DIR, subdir, name), 'utf-8');
}

function readOutput(dir, filename) {
  return readFileSync(join(dir, filename), 'utf-8');
}

// ===========================================================================
// PREPROCESS TESTS
// ===========================================================================

suite('preprocess.mjs — deobfuscation', () => {
  const inputFile = join(FIXTURES_DIR, 'preprocess', 'deobfuscate.input.js');
  const expected = readFixture('preprocess', 'deobfuscate.expected.js');

  runTest('converts !0 to true and !1 to false', () => {
    const { outdir } = runPreprocess(inputFile);
    const output = readOutput(outdir, 'deobfuscate.input.js');
    assertContains(output, 'var a = true;', 'bool-true');
    assertContains(output, 'var b = false;', 'bool-false');
  });

  runTest('converts void 0 to undefined', () => {
    const { outdir } = runPreprocess(inputFile);
    const output = readOutput(outdir, 'deobfuscate.input.js');
    assertContains(output, 'var c = undefined;', 'void-0');
  });

  runTest('decodes hex escapes in strings', () => {
    const { outdir } = runPreprocess(inputFile);
    const output = readOutput(outdir, 'deobfuscate.input.js');
    assertContains(output, '"hello=world"', 'hex-3d');
    assertContains(output, '"foo&bar"', 'hex-26');
  });

  runTest('decodes unicode escapes to printable ASCII', () => {
    const { outdir } = runPreprocess(inputFile);
    const output = readOutput(outdir, 'deobfuscate.input.js');
    assertContains(output, '"ABC"', 'unicode');
  });

  runTest('normalizes typeof comparisons', () => {
    const { outdir } = runPreprocess(inputFile);
    const output = readOutput(outdir, 'deobfuscate.input.js');
    assertContains(output, 'typeof window != "undefined"', 'typeof-normalize');
    assertContains(output, 'typeof x === "string"', 'typeof-normalize-2');
  });
});

suite('preprocess.mjs — structural analysis', () => {
  runTest('detects IIFEs, classes, functions, and globals', () => {
    const inputFile = join(FIXTURES_DIR, 'preprocess', 'analysis.input.js');
    const { outdir } = runPreprocess(inputFile, '--analyze');
    const report = readOutput(outdir, '_analysis.txt');
    assertContains(report, 'IIFEs: 1', 'iife-count');
    assertContains(report, 'Classes: 1', 'class-count');
    assertMatch(report, /Named functions:.*[1-9]/, 'func-count');
    assertContains(report, 'EventEmitter', 'class-name');
    assertContains(report, 'createLogger', 'func-name');
    assertContains(report, 'MyLib', 'global-assignment');
  });

  runTest('always writes _analysis.txt', () => {
    const inputFile = join(FIXTURES_DIR, 'preprocess', 'deobfuscate.input.js');
    const { outdir } = runPreprocess(inputFile);
    assert(existsSync(join(outdir, '_analysis.txt')), 'analysis file should always be created');
  });
});

suite('preprocess.mjs — bundle splitting', () => {
  runTest('splits webpack module map into individual files', () => {
    const inputFile = join(FIXTURES_DIR, 'preprocess', 'webpack-split.input.js');
    const { outdir } = runPreprocess(inputFile, '--split');
    const modulesDir = join(outdir, 'modules');
    assert(existsSync(modulesDir), 'modules/ directory should be created');

    const files = readdirSync(modulesDir);
    assert(files.length >= 3, `expected at least 3 module files, got ${files.length}: ${files}`);
    assert(files.some(f => f.includes('101')), 'module-101 file should exist');
    assert(files.some(f => f.includes('202')), 'module-202 file should exist');
    assert(files.some(f => f.includes('303')), 'module-303 file should exist');

    // Verify content landed in the right file
    const mod101 = readOutput(modulesDir, files.find(f => f.includes('101')));
    assertContains(mod101, 'greet', 'module-101-content');
  });

  runTest('splits .register() bundles by registration name', () => {
    const inputFile = join(FIXTURES_DIR, 'preprocess', 'register-split.input.js');
    const { outdir } = runPreprocess(inputFile, '--split');
    const modulesDir = join(outdir, 'modules');
    assert(existsSync(modulesDir), 'modules/ directory should be created');

    const files = readdirSync(modulesDir);
    assert(files.length >= 2, `expected at least 2 module files, got ${files.length}: ${files}`);
    assert(files.some(f => f.includes('myModule_utils')), 'utils module file should exist');
    assert(files.some(f => f.includes('myModule_main')), 'main module file should exist');
  });
});

// ===========================================================================
// JSX-RESTORE TESTS
// ===========================================================================

suite('jsx-restore.mjs — basic conversions', () => {
  runTest('converts self-closing jsx() to <Component />', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'basic-self-closing.input.js');
    const { outdir } = runJsxRestore(inputFile);
    const output = readOutput(outdir, 'basic-self-closing.input.jsx');
    assertContains(output, '<Spinner />', 'self-closing');
    assertNotContains(output, 'jsx(', 'no-jsx-calls');
  });

  runTest('converts jsx() with props and children', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'basic-with-props.input.js');
    const { outdir } = runJsxRestore(inputFile);
    const output = readOutput(outdir, 'basic-with-props.input.jsx');
    assertMatch(output, /<Button[\s\S]*disabled[\s\S]*>/, 'button-disabled');
    assertContains(output, 'Submit', 'children-text');
    assertNotContains(output, 'jsx(', 'no-jsx-calls');
  });

  runTest('handles boolean shorthand (true → no value)', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'basic-with-props.input.js');
    const { outdir } = runJsxRestore(inputFile);
    const output = readOutput(outdir, 'basic-with-props.input.jsx');
    // disabled={true} should become just disabled (shorthand)
    assertNotContains(output, 'disabled={true}', 'bool-shorthand');
    assertMatch(output, /\bdisabled\b/, 'has-disabled-attr');
  });
});

suite('jsx-restore.mjs — nesting', () => {
  runTest('converts nested jsx/jsxs calls to nested JSX elements', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'nested.input.js');
    const { outdir } = runJsxRestore(inputFile);
    const output = readOutput(outdir, 'nested.input.jsx');
    assertContains(output, '<Modal', 'outer-element');
    assertContains(output, '<ModalBody', 'mid-element');
    assertContains(output, '<ModalTitle', 'inner-element');
    assertContains(output, '<Button', 'sibling-element');
    assertNotContains(output, 'jsx(', 'no-jsx-calls');
    assertNotContains(output, 'jsxs(', 'no-jsxs-calls');
  });
});

suite('jsx-restore.mjs — fragments', () => {
  runTest('converts Fragment to <> </> syntax', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'fragment.input.js');
    const { outdir } = runJsxRestore(inputFile);
    const output = readOutput(outdir, 'fragment.input.jsx');
    assertContains(output, '<>', 'fragment-open');
    assertContains(output, '</>', 'fragment-close');
    assertContains(output, '<button', 'child-elements');
    assertNotContains(output, 'Fragment', 'no-fragment-identifier');
  });
});

suite('jsx-restore.mjs — comma expression unwrap', () => {
  runTest('converts (0, _jsx)(...) pattern', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'comma-unwrap.input.js');
    const { outdir } = runJsxRestore(inputFile);
    const output = readOutput(outdir, 'comma-unwrap.input.jsx');
    assertContains(output, '<div', 'div-element');
    assertContains(output, '<Spinner />', 'spinner-self-closing');
    assertContains(output, '<Alert', 'alert-element');
    assertNotContains(output, '(0,', 'no-comma-expressions');
    assertNotContains(output, '_jsx', 'no-underscore-jsx');
  });
});

suite('jsx-restore.mjs — createElement', () => {
  runTest('converts createElement() to JSX', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'create-element.input.js');
    const { outdir } = runJsxRestore(inputFile);
    const output = readOutput(outdir, 'create-element.input.jsx');
    assertContains(output, '<div', 'div-element');
    assertContains(output, '<h1', 'h1-element');
    assertContains(output, '<p', 'p-element');
    assertContains(output, 'Title', 'h1-text');
    assertNotContains(output, 'createElement', 'no-createElement');
  });
});

suite('jsx-restore.mjs — key as third argument', () => {
  runTest('moves key from 3rd arg to JSX attribute', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'key-third-arg.input.js');
    const { outdir } = runJsxRestore(inputFile);
    const output = readOutput(outdir, 'key-third-arg.input.jsx');
    assertMatch(output, /key=\{item\.id\}/, 'key-attribute');
    assertContains(output, '<li', 'li-element');
    assertNotContains(output, 'jsx(', 'no-jsx-calls');
  });
});

suite('jsx-restore.mjs — no-op on non-JSX files', () => {
  runTest('skips files without jsx/jsxs/createElement calls', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'no-jsx.input.js');
    const { stdout } = runJsxRestore(inputFile);
    assertContains(stdout, 'No jsx', 'skip-message');
    // Should not create a .jsx file
    const outputExists = existsSync(join(TMP_DIR, 'jsx-out', 'no-jsx.input.jsx'));
    assert(!outputExists, 'should not create .jsx file for non-JSX input');
  });
});

suite('jsx-restore.mjs — import cleanup', () => {
  runTest('removes react/jsx-runtime import', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'basic-self-closing.input.js');
    const { outdir } = runJsxRestore(inputFile);
    const output = readOutput(outdir, 'basic-self-closing.input.jsx');
    assertNotContains(output, 'react/jsx-runtime', 'no-runtime-import');
    // Component import should be preserved
    assertContains(output, "from './spinner'", 'spinner-import-preserved');
  });

  runTest('preserves non-jsx-runtime imports', () => {
    const inputFile = join(FIXTURES_DIR, 'jsx-restore', 'nested.input.js');
    const { outdir } = runJsxRestore(inputFile);
    const output = readOutput(outdir, 'nested.input.jsx');
    assertContains(output, "from './modal'", 'modal-import');
    assertContains(output, "from './modal-body'", 'modal-body-import');
    assertContains(output, "from './button'", 'button-import');
  });
});

function jsBody(prefix) {
  return `${prefix}/*${'x'.repeat(1200)}*/`;
}

function runCapture(args) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(process.execPath, [join(SKILL_DIR, 'capture.mjs'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      rejectCapture(new Error('capture timed out'));
    }, 60_000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectCapture(err);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveCapture({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function assertExit(result, code, label) {
  assert(
    result.status === code,
    `${label}: exit ${result.status}, expected ${code}\n${result.stderr}\n${result.stdout}`,
  );
}

function readCapture(outRoot) {
  const dirs = readdirSync(outRoot).filter((name) => existsSync(join(outRoot, name, 'capture.json')));
  assert(dirs.length === 1, `expected one capture directory, found ${dirs.join(', ') || 'none'}`);
  const root = join(outRoot, dirs[0]);
  const capture = JSON.parse(readFileSync(join(root, 'capture.json'), 'utf-8'));
  return { root, capture };
}

function assetBySource(capture, pred) {
  return capture.assets.find((asset) => asset.sources.some(pred));
}

async function withServer(routes, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url || '');
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(route.status || 200, {
      'content-type': route.type || 'text/html; charset=utf-8',
    });
    res.end(route.body);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    await fn({ origin, seen, url: (path) => origin + path });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

suite('capture.mjs — page URL', () => {
  const mainJs = `import "./chunk.js";void __webpack_require__.u;/*${'M'.repeat(1200)}*/`;
  const chunkJs = jsBody('export const chunkValue = 1;');
  const preloadJs = jsBody('export const preloaded = 1;');
  const baseJs = jsBody('export const fromBase = 1;');
  const shortInline = 'var shortInline = 1;';
  const longInline = jsBody('var longInline = 1;');
  const shortData = 'var shortData = 2;';
  const longData = jsBody('var longData = 2;');
  const appData = 'var appData = 3;';
  const page = `<!doctype html>
<html><head>
<base href="/assets/">
<link rel="modulepreload" href="/assets/preload.js">
<script src="/assets/main.js?v=12"></script>
<script src="from-base.js"></script>
</head><body>
<script>${shortInline}</script>
<script>${longInline}</script>
<script type="application/json">{"ignored":true}</script>
<noscript><script src="/assets/noscript.js"></script></noscript>
<template><script src="/assets/in-template.js"></script></template>
<frameset><script src="/assets/in-frameset.js"></script></frameset>
<script src="data:text/javascript,${encodeURIComponent(longData)}"></script>
<script src="data:text/javascript,${encodeURIComponent(shortData)}"></script>
<script src="data:application/javascript,${encodeURIComponent(appData)}"></script>
<script src="javascript:alert(1)"></script>
</body></html>`;

  runTest('captures scripts, imports, and skips from one page', async () => {
    await withServer({
      '/page.html': { body: page },
      '/assets/main.js': { type: 'text/javascript', body: mainJs },
      '/assets/chunk.js': { type: 'text/javascript', body: chunkJs },
      '/assets/preload.js': { type: 'text/javascript', body: preloadJs },
      '/assets/from-base.js': { type: 'text/javascript', body: baseJs },
    }, async ({ origin, seen, url }) => {
      const out = join(TMP_DIR, 'out');
      const result = await runCapture([url('/page.html'), '--out', out, '--no-format']);
      assertExit(result, 0, 'page capture');
      const { capture } = readCapture(out);

      const main = assetBySource(capture, (source) => source.kind === 'script-src' && source.url === `${origin}/assets/main.js?v=12`);
      assert(main, 'main asset missing');
      assert(main.status.kind === 'ready', 'main should be ready');
      assert(existsSync(main.status.analysis), 'main analysis missing');
      assert(main.bytes === Buffer.byteLength(mainJs), `main bytes ${main.bytes}`);

      const chunk = assetBySource(capture, (source) => source.kind === 'import' && source.url === `${origin}/assets/chunk.js`);
      assert(chunk, 'chunk import missing');
      assert(chunk.status.kind === 'ready', 'chunk should be ready');
      assert(existsSync(chunk.status.analysis), 'chunk analysis missing');
      const importSource = chunk.sources.find((source) => source.kind === 'import');
      assert(importSource, 'chunk import source missing');
      assert(importSource.from === main.id, 'chunk import should name main');

      const preload = assetBySource(capture, (source) => source.kind === 'preload' && source.url === `${origin}/assets/preload.js`);
      assert(preload, 'modulepreload asset missing');
      assert(preload.status.kind === 'ready', 'preload should be ready');
      assert(existsSync(preload.status.analysis), 'preload analysis missing');

      const fromBase = assetBySource(capture, (source) => source.kind === 'script-src' && source.url === `${origin}/assets/from-base.js`);
      assert(fromBase, 'base href script missing');
      assert(fromBase.status.kind === 'ready', 'base script should be ready');
      assert(existsSync(fromBase.status.analysis), 'base script analysis missing');

      const long = capture.assets.find((asset) => asset.bytes === Buffer.byteLength(longInline));
      assert(long, 'long inline missing');
      assert(long.status.kind === 'ready', 'long inline should be ready');
      assert(long.sources[0].kind === 'inline', 'long inline source');
      assert(existsSync(long.status.analysis), 'long inline analysis missing');

      const short = capture.assets.find((asset) => asset.bytes === Buffer.byteLength(shortInline));
      assert(short, 'short inline missing');
      assert(short.status.kind === 'skipped', 'short inline should be skipped');
      assert(short.status.reason === 'too-small', 'short inline reason');
      assert(!('analysis' in short.status), 'skipped asset has no analysis path');

      const longDataAsset = capture.assets.find((asset) => asset.bytes === Buffer.byteLength(longData));
      assert(longDataAsset, 'long data script missing');
      assert(longDataAsset.status.kind === 'ready', 'long data script should be ready');
      assert(longDataAsset.sources[0].kind === 'inline', 'data script is inline');
      assert(existsSync(longDataAsset.status.analysis), 'data script analysis missing');

      const shortDataAsset = capture.assets.find((asset) => asset.bytes === Buffer.byteLength(shortData));
      assert(shortDataAsset, 'short data script missing');
      assert(shortDataAsset.status.kind === 'skipped', 'short data script should be skipped');
      assert(shortDataAsset.status.reason === 'too-small', 'short data reason');
      assert(shortDataAsset.sources[0].kind === 'inline', 'short data script is inline');

      const appDataAsset = capture.assets.find((asset) => asset.bytes === Buffer.byteLength(appData));
      assert(appDataAsset, 'application/javascript data script missing');
      assert(appDataAsset.status.kind === 'skipped', 'short application/javascript data script should be skipped');
      assert(appDataAsset.status.reason === 'too-small', 'application/javascript data reason');
      assert(appDataAsset.sources[0].kind === 'inline', 'application/javascript data script is inline');

      const expectedBytes = [mainJs, chunkJs, preloadJs, baseJs, shortInline, longInline, shortData, longData, appData]
        .map((body) => Buffer.byteLength(body))
        .sort((a, b) => a - b);
      const actualBytes = capture.assets.map((asset) => asset.bytes).sort((a, b) => a - b);
      assert(JSON.stringify(actualBytes) === JSON.stringify(expectedBytes), `asset bytes ${actualBytes.join(',')} expected ${expectedBytes.join(',')}`);

      const gap = capture.gaps.find((entry) => entry.kind === 'runtime-chunks');
      assert(gap, 'runtime-chunks gap missing');
      assert(gap.assetId === main.id, 'runtime-chunks gap should name main');

      assert(seen.includes('/assets/main.js?v=12'), `server did not see main: ${seen.join(' ')}`);
      assert(seen.includes('/assets/chunk.js'), 'server did not see chunk');
      assert(!seen.some((path) => path.includes('noscript') || path.includes('in-template') || path.includes('in-frameset')), `ignored tag was fetched: ${seen.join(' ')}`);
      assert(!seen.some((path) => path.includes('javascript') || path.includes('data:')), `non-fetched url was requested: ${seen.join(' ')}`);
    });
  });

  runTest('exits 2 and records no-scripts when the page has no executable scripts', async () => {
    const html = '<!doctype html><html><body><p>Nothing to capture.</p><script type="application/json">{"a":1}</script></body></html>';
    await withServer({ '/empty.html': { body: html } }, async ({ url }) => {
      const out = join(TMP_DIR, 'out');
      const result = await runCapture([url('/empty.html'), '--out', out, '--no-format']);
      assertExit(result, 2, 'empty page');
      const { capture } = readCapture(out);
      assert(capture.assets.length === 0, 'empty page should have no assets');
      assert(capture.gaps.length === 1, `gaps ${JSON.stringify(capture.gaps)}`);
      assert(capture.gaps[0].kind === 'no-scripts', 'missing no-scripts gap');
    });
  });

  runTest('rejects a URL with userinfo and writes no capture', async () => {
    const out = join(TMP_DIR, 'out');
    mkdirSync(out);
    const result = await runCapture(['http://alice:secret@127.0.0.1/page', '--out', out, '--no-format']);
    assertExit(result, 1, 'userinfo');
    assert(result.stderr.includes('username') || result.stderr.includes('password'), result.stderr);
    assert(readdirSync(out).length === 0, `wrote ${readdirSync(out).join(', ')}`);
  });

  runTest('captures a direct script URL as one document asset', async () => {
    const body = jsBody('function directScript(){return 1}');
    await withServer({
      '/app.js': { type: 'application/javascript', body },
    }, async ({ origin, url }) => {
      const out = join(TMP_DIR, 'out');
      const result = await runCapture([url('/app.js'), '--out', out, '--no-format']);
      assertExit(result, 0, 'direct script');
      const { capture } = readCapture(out);
      assert(capture.assets.length === 1, `expected 1 asset, got ${capture.assets.length}`);
      const asset = capture.assets[0];
      assert(asset.sources[0].kind === 'document', 'source kind');
      assert(asset.sources[0].url === `${origin}/app.js`, `url ${asset.sources[0].url}`);
      assert(asset.status.kind === 'ready', 'direct script should be ready');
      assert(existsSync(asset.status.analysis), 'direct script analysis missing');
    });
  });

  runTest('running the same page URL twice keeps one capture directory', async () => {
    const body = jsBody('function once(){return 1}');
    const html = '<!doctype html><html><body><script src="/once.js"></script></body></html>';
    await withServer({
      '/page.html': { body: html },
      '/once.js': { type: 'text/javascript', body },
    }, async ({ url }) => {
      const out = join(TMP_DIR, 'out');
      const args = [url('/page.html'), '--out', out, '--no-format'];
      const first = await runCapture(args);
      assertExit(first, 0, 'first capture');
      const { root, capture } = readCapture(out);
      const marker = join(root, 'keep.txt');
      writeFileSync(marker, 'kept');
      const analysis = capture.assets.filter((asset) => asset.status.kind === 'ready').map((asset) => asset.status.analysis);
      assert(analysis.length === 1, 'first run should have one ready asset');
      assert(existsSync(analysis[0]), 'analysis missing after first run');

      const second = await runCapture(args);
      assertExit(second, 0, 'second capture');
      assert(readdirSync(out).length === 1, `directories ${readdirSync(out).join(', ')}`);
      assert(readFileSync(marker, 'utf8') === 'kept', 'second run deleted the previous capture');
      const again = JSON.parse(readFileSync(join(root, 'capture.json'), 'utf8'));
      assert(again.id === capture.id, 'capture id changed');
      const ready = again.assets.filter((asset) => asset.status.kind === 'ready');
      assert(ready.length === 1, 'second manifest should have one ready asset');
      assert(ready[0].status.analysis === analysis[0], 'analysis path changed');
      assert(existsSync(ready[0].status.analysis), 'analysis missing after second run');
    });
  });
});

suite('capture.mjs — local path', () => {
  runTest('captures a local js path as one local asset', async () => {
    const file = join(TMP_DIR, 'bundle.js');
    const body = jsBody('function localBundle(){return 1}');
    writeFileSync(file, body);
    const out = join(TMP_DIR, 'out');
    const result = await runCapture([file, '--out', out, '--no-format']);
    assertExit(result, 0, 'local path');
    const { capture } = readCapture(out);
    assert(capture.assets.length === 1, `expected 1 asset, got ${capture.assets.length}`);
    const asset = capture.assets[0];
    assert(asset.sources[0].kind === 'local', 'source kind');
    assert(asset.sources[0].path === file, `path ${asset.sources[0].path}`);
    assert(asset.status.kind === 'ready', 'local file should be ready');
    assert(existsSync(asset.status.analysis), 'local analysis missing');
  });
});

// ===========================================================================
// Summary
// ===========================================================================

chain.then(() => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`\x1b[1mResults: ${passed} passed, ${failed} failed, ${skipped} skipped\x1b[0m`);

  if (failures.length > 0) {
    console.log(`\n\x1b[31mFailures:\x1b[0m`);
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }

  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  process.exit(failed > 0 ? 1 : 0);
});
