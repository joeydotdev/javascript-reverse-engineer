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
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
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

function runTest(name, fn) {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) {
    skipped++;
    return;
  }

  try {
    cleanTmp();
    fn();
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
}

function suite(name, fn) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
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

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`\x1b[1mResults: ${passed} passed, ${failed} failed, ${skipped} skipped\x1b[0m`);

if (failures.length > 0) {
  console.log(`\n\x1b[31mFailures:\x1b[0m`);
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

// Cleanup
if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });

process.exit(failed > 0 ? 1 : 0);
