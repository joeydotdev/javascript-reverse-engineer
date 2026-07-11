#!/usr/bin/env node

/**
 * @fileoverview Deminification preprocessor — mechanical transforms only.
 *
 * Runs BEFORE the LLM touches the code. Handles everything that doesn't
 * require semantic understanding, saving significant token cost.
 *
 * Usage:
 *   node preprocess.mjs <input.js> [--outdir <dir>] [--split] [--analyze]
 *
 * Flags:
 *   --outdir <dir>   Output directory (default: <input>-preprocessed/)
 *   --split          Attempt to split webpack/bundler module maps into
 *                    individual files (one per module ID)
 *   --analyze        Print a structural analysis report (module boundaries,
 *                    function/class counts, dependency graph sketch)
 *   --no-format      Skip the prettier formatting step
 *
 * Zero external dependencies — uses only Node.js builtins.
 * For better formatting, install prettier: npm i -g prettier
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log(`Usage: node preprocess.mjs <input.js> [--outdir <dir>] [--split] [--analyze] [--no-format]`);
  process.exit(0);
}

const inputPath = resolve(args.find(a => !a.startsWith('--')));
const outdir = (() => {
  const idx = args.indexOf('--outdir');
  if (idx !== -1 && args[idx + 1]) return resolve(args[idx + 1]);
  const base = basename(inputPath, extname(inputPath));
  return resolve('output', base + '-preprocessed');
})();
const shouldSplit = args.includes('--split');
const shouldAnalyze = args.includes('--analyze');
const shouldFormat = !args.includes('--no-format');

// ---------------------------------------------------------------------------
// Read source
// ---------------------------------------------------------------------------

let source;
try {
  source = readFileSync(inputPath, 'utf-8');
} catch (err) {
  console.error(`Error reading ${inputPath}: ${err.message}`);
  process.exit(1);
}

console.log(`Read ${source.length} chars (${source.split('\n').length} lines) from ${inputPath}`);

// ---------------------------------------------------------------------------
// Phase 1: Mechanical deobfuscation (regex-based, no AST needed)
// ---------------------------------------------------------------------------

function deobfuscate(code) {
  let result = code;

  // !0 -> true, !1 -> false (only when not inside a string)
  // We do a rough pass — good enough for preprocessed code.
  result = result.replace(/(?<!["\w])!0(?![\w"])/g, 'true');
  result = result.replace(/(?<!["\w])!1(?![\w"])/g, 'false');

  // void 0 -> undefined
  result = result.replace(/\bvoid 0\b/g, 'undefined');

  // Hex escapes in strings: \x3d -> =, \x26 -> &, etc.
  result = result.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    // Keep certain chars escaped if they'd break strings
    if (ch === "'" || ch === '"' || ch === '\\' || ch === '\n' || ch === '\r') {
      return '\\x' + hex;
    }
    return ch;
  });

  // Unicode escapes: \u0041 -> A (only printable ASCII+)
  result = result.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
    const code = parseInt(hex, 16);
    if (code >= 0x20 && code < 0x7f) {
      const ch = String.fromCharCode(code);
      if (ch === "'" || ch === '"' || ch === '\\') return match;
      return ch;
    }
    return match;
  });

  // typeof normalization: "undefined" != typeof x -> typeof x != "undefined"
  // Must run BEFORE the general comparison flip to avoid corrupting typeof exprs.
  result = result.replace(
    /("[^"]*"|'[^']*')\s*(!==?|===?)\s*typeof\s+(\w+)/g,
    (_, lit, op, name) => `typeof ${name} ${op} ${lit}`
  );

  // Normalize comparison order: "string" === var -> var === "string"
  // (minifiers sometimes flip these; humans read LHS-variable better)
  // Excludes typeof (already handled above) to avoid producing broken syntax.
  result = result.replace(
    /("[^"]*"|'[^']*')\s*(===|!==)\s*(\w+)/g,
    (_, lit, op, name) => {
      if (name === 'typeof') return `${lit} ${op} ${name}`; // don't flip typeof
      return `${name} ${op} ${lit}`;
    }
  );

  return result;
}

// ---------------------------------------------------------------------------
// Phase 2: Structural analysis
// ---------------------------------------------------------------------------

function analyze(code) {
  const report = {
    totalLines: code.split('\n').length,
    totalChars: code.length,
    functions: [],
    classes: [],
    iifes: 0,
    webpackModules: [],
    registrations: [],
    defines: [],
    exports: [],
    globalAssignments: [],
    stringConstants: [],
  };

  // Count IIFEs
  const iifeMatches = code.match(/(?:!function|\(function)\s*\(/g);
  report.iifes = iifeMatches ? iifeMatches.length : 0;

  // Find function declarations and named function expressions
  const funcRegex = /function\s+([a-zA-Z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = funcRegex.exec(code)) !== null) {
    report.functions.push({ name: m[1], offset: m.index });
  }

  // Find class declarations
  const classRegex = /class\s+([a-zA-Z_$][\w$]*)/g;
  while ((m = classRegex.exec(code)) !== null) {
    report.classes.push({ name: m[1], offset: m.index });
  }

  // Find .register() calls (Amazon-style)
  const regRegex = /\.register\(\s*["']([^"']+)["']/g;
  while ((m = regRegex.exec(code)) !== null) {
    report.registrations.push({ name: m[1], offset: m.index });
  }

  // Find define() calls (AMD)
  const defineRegex = /\bdefine\(\s*["']([^"']+)["']/g;
  while ((m = defineRegex.exec(code)) !== null) {
    report.defines.push({ name: m[1], offset: m.index });
  }

  // Find module.exports / exports.X assignments
  const exportRegex = /(?:module\.exports|exports\.(\w+))\s*=/g;
  while ((m = exportRegex.exec(code)) !== null) {
    report.exports.push({ name: m[1] || 'default', offset: m.index });
  }

  // Find window.X / globalThis.X / self.X assignments
  const globalRegex = /(?:window|globalThis|self)\.([a-zA-Z_$][\w$]*)\s*=/g;
  while ((m = globalRegex.exec(code)) !== null) {
    if (!m[1].startsWith('webkit') && m[1] !== '__proto__') {
      report.globalAssignments.push({ name: m[1], offset: m.index });
    }
  }

  // Detect webpack-style module maps: { 42: function(e,t,n) { ... } }
  // Look for numeric keys followed by function definitions
  const webpackModRegex = /(\d+)\s*:\s*function\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)/g;
  while ((m = webpackModRegex.exec(code)) !== null) {
    report.webpackModules.push({ id: m[1], offset: m.index });
  }

  // Also check for string-keyed webpack modules (webpack 5)
  const webpackStrModRegex = /["'](\w{4,})["']\s*:\s*function\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)/g;
  while ((m = webpackStrModRegex.exec(code)) !== null) {
    report.webpackModules.push({ id: m[1], offset: m.index });
  }

  // Collect long string constants (potential metric names, URLs, etc.)
  const stringRegex = /["']([^"'\n]{30,})["']/g;
  const seen = new Set();
  while ((m = stringRegex.exec(code)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      report.stringConstants.push(m[1]);
    }
  }

  return report;
}

function formatReport(report) {
  const lines = [
    '=== Structural Analysis Report ===',
    '',
    `Total: ${report.totalLines} lines, ${report.totalChars} chars`,
    `IIFEs: ${report.iifes}`,
    `Named functions: ${report.functions.length}`,
    `Classes: ${report.classes.length}`,
    `Webpack modules: ${report.webpackModules.length}`,
    `Module registrations (.register): ${report.registrations.length}`,
    `AMD defines: ${report.defines.length}`,
    `Exports: ${report.exports.length}`,
    `Global assignments: ${report.globalAssignments.length}`,
    '',
  ];

  if (report.registrations.length > 0) {
    lines.push('--- Registered Modules ---');
    report.registrations.forEach(r => lines.push(`  ${r.name} (offset ${r.offset})`));
    lines.push('');
  }

  if (report.webpackModules.length > 0) {
    lines.push('--- Webpack Module IDs ---');
    report.webpackModules.forEach(r => lines.push(`  module ${r.id} (offset ${r.offset})`));
    lines.push('');
  }

  if (report.classes.length > 0) {
    lines.push('--- Classes ---');
    report.classes.forEach(r => lines.push(`  ${r.name} (offset ${r.offset})`));
    lines.push('');
  }

  if (report.functions.length > 0) {
    lines.push('--- Named Functions ---');
    report.functions.forEach(r => lines.push(`  ${r.name}() (offset ${r.offset})`));
    lines.push('');
  }

  if (report.globalAssignments.length > 0) {
    lines.push('--- Global Assignments ---');
    report.globalAssignments.forEach(r => lines.push(`  ${r.name} (offset ${r.offset})`));
    lines.push('');
  }

  if (report.stringConstants.length > 0) {
    lines.push(`--- Notable String Constants (${report.stringConstants.length}) ---`);
    report.stringConstants.slice(0, 50).forEach(s => {
      lines.push(`  "${s.length > 80 ? s.slice(0, 77) + '...' : s}"`);
    });
    if (report.stringConstants.length > 50) {
      lines.push(`  ... and ${report.stringConstants.length - 50} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 3: Webpack bundle splitting
// ---------------------------------------------------------------------------

function splitWebpackBundle(code) {
  const modules = new Map();

  // Strategy: find the module map object and extract each module function.
  // Webpack bundles typically look like:
  //   (function(modules) { ... })({ 0: function(e,t,n) { ... }, 1: ... })
  // or webpack 5:
  //   (self.webpackChunkXXX = ...).push([[ids], { id: function(e,t,n) { ... } }])
  //
  // We use a brace-depth counter to find module boundaries.

  // Find candidate module map starts: numeric-key or string-key function entries
  const moduleStartRegex = /(?:^|[,{])\s*(?:(\d+)|["'](\w+)["'])\s*:\s*function\s*\(/gm;
  const entries = [];
  let match;

  while ((match = moduleStartRegex.exec(code)) !== null) {
    entries.push({
      id: match[1] || match[2],
      funcStart: code.indexOf('function', match.index),
    });
  }

  if (entries.length < 2) return modules; // Not enough to be a webpack bundle

  // For each entry, find the end by counting braces
  for (let i = 0; i < entries.length; i++) {
    const start = entries[i].funcStart;
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let escaped = false;
    let end = start;

    for (let j = start; j < code.length; j++) {
      const ch = code[j];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        continue;
      }

      if (inString) {
        if (ch === stringChar) inString = false;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
        continue;
      }

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }

    if (end > start) {
      modules.set(entries[i].id, code.slice(start, end));
    }
  }

  return modules;
}

// ---------------------------------------------------------------------------
// Phase 4: Formatting (prettier if available, otherwise basic)
// ---------------------------------------------------------------------------

function tryPrettier(code) {
  try {
    const result = execSync('npx --yes prettier --parser babel --single-quote --trailing-comma all --print-width 100', {
      input: code,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result;
  } catch {
    console.log('  prettier not available, using basic formatting');
    return basicFormat(code);
  }
}

function basicFormat(code) {
  // Very rough formatting for when prettier isn't available.
  // Just ensures newlines after braces and semicolons at reasonable points.
  let result = code;

  // Ensure newline after { and before }
  result = result.replace(/\{(?!\s*\n)/g, '{\n');
  result = result.replace(/(?<!\n)\s*\}/g, '\n}');

  // Ensure newline after ; when not inside for()
  result = result.replace(/;(?!\s*\n)(?![^(]*\))/g, ';\n');

  // Remove excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(outdir, { recursive: true });
console.log(`Output directory: ${outdir}`);

// Step 1: Deobfuscate
console.log('\n--- Deobfuscating ---');
let processed = deobfuscate(source);
const deobfChanges = source.length - processed.length;
console.log(`  Deobfuscation complete (${Math.abs(deobfChanges)} chars ${deobfChanges > 0 ? 'removed' : 'added'})`);

// Step 2: Analyze (always, even if --analyze not passed — we save the report)
console.log('\n--- Analyzing structure ---');
const report = analyze(processed);
const reportText = formatReport(report);

if (shouldAnalyze) {
  console.log('\n' + reportText);
}

writeFileSync(join(outdir, '_analysis.txt'), reportText, 'utf-8');
console.log(`  Analysis saved to ${join(outdir, '_analysis.txt')}`);

// Step 3: Split (if requested and webpack modules detected)
if (shouldSplit && report.webpackModules.length > 0) {
  console.log(`\n--- Splitting ${report.webpackModules.length} webpack modules ---`);
  const modules = splitWebpackBundle(processed);

  if (modules.size > 0) {
    const splitDir = join(outdir, 'modules');
    mkdirSync(splitDir, { recursive: true });

    for (const [id, body] of modules) {
      const filename = `module-${id}.js`;
      let moduleCode = body;
      if (shouldFormat) {
        moduleCode = tryPrettier(body);
      }
      writeFileSync(join(splitDir, filename), moduleCode, 'utf-8');
    }
    console.log(`  Split ${modules.size} modules into ${join(outdir, 'modules/')}`);
  } else {
    console.log('  Could not extract module boundaries (complex bundle structure)');
  }
} else if (shouldSplit && report.registrations.length > 0) {
  console.log(`\n--- Splitting ${report.registrations.length} registered modules ---`);
  // For .register()-style bundles, split on registration boundaries
  const splitDir = join(outdir, 'modules');
  mkdirSync(splitDir, { recursive: true });

  // Sort registrations by offset
  const sorted = [...report.registrations].sort((a, b) => a.offset - b.offset);

  for (let i = 0; i < sorted.length; i++) {
    // Find the enclosing IIFE or section
    // Look backwards from the registration for the nearest `(function` or `!function`
    const regOffset = sorted[i].offset;
    let sectionStart = regOffset;

    // Search backwards for IIFE start
    const preceding = processed.slice(Math.max(0, regOffset - 500), regOffset);
    const iifeMatch = preceding.match(/.*(?:\(function|!function)/s);
    if (iifeMatch) {
      sectionStart = regOffset - (preceding.length - preceding.lastIndexOf(iifeMatch[0].slice(-9)));
    }

    // Section ends at next registration's IIFE or end of file
    const sectionEnd = i < sorted.length - 1
      ? sorted[i + 1].offset
      : processed.length;

    const sectionCode = processed.slice(Math.max(0, sectionStart - 200), sectionEnd);
    const safeName = sorted[i].name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeName}.js`;

    let moduleCode = sectionCode;
    if (shouldFormat) {
      moduleCode = tryPrettier(sectionCode);
    }
    writeFileSync(join(splitDir, filename), moduleCode, 'utf-8');
  }
  console.log(`  Split ${sorted.length} modules into ${join(outdir, 'modules/')}`);
}

// Step 4: Format the full file
if (shouldFormat) {
  console.log('\n--- Formatting ---');
  processed = tryPrettier(processed);
}

// Step 5: Write the processed output
const outputFile = join(outdir, basename(inputPath));
writeFileSync(outputFile, processed, 'utf-8');
console.log(`\nProcessed file written to: ${outputFile}`);
console.log(`  ${processed.split('\n').length} lines, ${processed.length} chars`);
console.log('\nDone. The LLM can now work with the preprocessed files.');
