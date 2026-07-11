#!/usr/bin/env node

/**
 * @fileoverview JSX Restoration Script
 *
 * Converts jsx()/jsxs()/createElement() function calls back to JSX syntax.
 * Works on already-deminified files (or any JS file using the React JSX runtime).
 *
 * Usage:
 *   node jsx-restore.mjs <file.js>              # Convert single file → file.jsx
 *   node jsx-restore.mjs <directory>             # Convert all .js files in directory
 *   node jsx-restore.mjs <file.js> --in-place    # Overwrite (still renames to .jsx)
 *   node jsx-restore.mjs <file.js> --dry-run     # Print to stdout, don't write
 *   node jsx-restore.mjs <file.js> --outdir out/ # Write to different directory
 *
 * Requirements:
 *   npm install @babel/parser @babel/traverse @babel/types @babel/generator
 *
 *   Or run the install command:
 *   node jsx-restore.mjs --install
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, extname, dirname } from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes('--help') || args.length === 0) {
  console.log(`
Usage: node jsx-restore.mjs <file-or-directory> [options]

Options:
  --in-place   Write output alongside input (renames .js → .jsx)
  --dry-run    Print transformed code to stdout
  --outdir <d> Write output files to a different directory
  --install    Install required babel dependencies

Converts jsx()/jsxs()/createElement() calls to JSX syntax.
Requires: @babel/parser @babel/traverse @babel/types @babel/generator
`.trim());
  process.exit(0);
}

if (args.includes('--install')) {
  console.log('Installing babel dependencies...');
  execSync('npm install --save-dev @babel/parser @babel/traverse @babel/types @babel/generator', {
    stdio: 'inherit',
    cwd: resolve('.'),
  });
  console.log('Done.');
  process.exit(0);
}

const inputPath = resolve(args.find(a => !a.startsWith('--')));
const isDryRun = args.includes('--dry-run');
const isInPlace = args.includes('--in-place');
const outdirIdx = args.indexOf('--outdir');
const outdir = outdirIdx !== -1 ? resolve(args[outdirIdx + 1]) : null;

// ---------------------------------------------------------------------------
// Load babel (with helpful error if not installed)
// ---------------------------------------------------------------------------

let parse, traverse, t, generate;

try {
  const parser = await import('@babel/parser');
  const traverseModule = await import('@babel/traverse');
  const typesModule = await import('@babel/types');
  const generatorModule = await import('@babel/generator');

  parse = parser.parse;
  traverse = traverseModule.default?.default || traverseModule.default || traverseModule;
  t = typesModule.default || typesModule;
  generate = generatorModule.default?.default || generatorModule.default || generatorModule;
} catch (err) {
  console.error(`
Error: babel packages not found. Install them with:

  npm install --save-dev @babel/parser @babel/traverse @babel/types @babel/generator

Or run:  node jsx-restore.mjs --install
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// JSX Restoration Transform
// ---------------------------------------------------------------------------

/**
 * Converts a string or identifier to a JSX element name.
 * - String literal "div" → JSXIdentifier("div")
 * - Identifier Foo → JSXIdentifier("Foo")
 * - MemberExpression Foo.Bar → JSXMemberExpression
 */
function toJSXName(node) {
  if (t.isStringLiteral(node)) {
    return t.jsxIdentifier(node.value);
  }
  if (t.isIdentifier(node)) {
    return t.jsxIdentifier(node.name);
  }
  if (t.isMemberExpression(node)) {
    return t.jsxMemberExpression(
      toJSXName(node.object),
      t.jsxIdentifier(node.property.name || node.property.value),
    );
  }
  // Fallback: can't convert, return null
  return null;
}

/**
 * Converts a value node to a JSX attribute value.
 * - StringLiteral → JSXAttribute with StringLiteral value
 * - Other → JSXExpressionContainer
 */
function toJSXAttrValue(node) {
  if (t.isStringLiteral(node)) {
    return t.stringLiteral(node.value);
  }
  if (t.isBooleanLiteral(node) && node.value === true) {
    // true → no value (shorthand)
    return null;
  }
  return t.jsxExpressionContainer(node);
}

/**
 * Converts an expression to a JSX child.
 * - StringLiteral → JSXText
 * - JSXElement → pass through
 * - Other → JSXExpressionContainer
 */
function toJSXChild(node) {
  if (t.isStringLiteral(node)) {
    // If the string contains characters that need escaping in JSX,
    // wrap in expression container
    if (node.value.includes('{') || node.value.includes('}') || node.value.includes('<') || node.value.includes('>')) {
      return t.jsxExpressionContainer(node);
    }
    return t.jsxText(node.value);
  }
  if (t.isJSXElement(node) || t.isJSXFragment(node)) {
    return node;
  }
  if (t.isNullLiteral(node)) {
    return null; // Skip null children
  }
  return t.jsxExpressionContainer(node);
}

/**
 * Attempts to convert a jsx()/jsxs()/createElement() call to a JSX element.
 * Returns the JSXElement/JSXFragment node, or null if conversion isn't possible.
 */
function convertCallToJSX(path, calleeName) {
  const args = path.node.arguments;
  if (args.length < 1) return null;

  const componentArg = args[0];
  const propsArg = args[1];
  const keyArg = args[2]; // jsx(Comp, props, key)

  // Check if this is a Fragment
  const isFragment = (
    (t.isIdentifier(componentArg) && componentArg.name === 'Fragment') ||
    (t.isMemberExpression(componentArg) &&
      t.isIdentifier(componentArg.property) &&
      componentArg.property.name === 'Fragment')
  );

  // Build JSX name
  const jsxName = isFragment ? null : toJSXName(componentArg);
  if (!isFragment && !jsxName) return null; // Can't convert

  // Extract props and children
  const attributes = [];
  let children = [];

  // Handle key from 3rd argument (jsx/jsxs only — not createElement)
  if (calleeName !== 'createElement' && keyArg &&
      !(t.isIdentifier(keyArg) && keyArg.name === 'undefined')) {
    attributes.push(
      t.jsxAttribute(t.jsxIdentifier('key'), toJSXAttrValue(keyArg)),
    );
  }

  // Extract props from the props object (works for both jsx/jsxs and createElement)
  if (t.isObjectExpression(propsArg)) {
    for (const prop of propsArg.properties) {
      if (t.isSpreadElement(prop)) {
        attributes.push(t.jsxSpreadAttribute(prop.argument));
        continue;
      }

      const propName = prop.computed
        ? null
        : t.isIdentifier(prop.key)
          ? prop.key.name
          : t.isStringLiteral(prop.key)
            ? prop.key.value
            : null;

      if (propName === null) {
        // Computed property — can't represent in JSX attributes
        return null;
      }

      // For jsx/jsxs, children are inside the props object.
      // For createElement, children are separate arguments — skip if found in props.
      if (propName === 'children' && calleeName !== 'createElement') {
        if (t.isArrayExpression(prop.value)) {
          children = prop.value.elements
            .map(el => el ? toJSXChild(el) : null)
            .filter(Boolean);
        } else {
          const child = toJSXChild(prop.value);
          if (child) children = [child];
        }
        continue;
      }

      // Regular prop
      const attrValue = toJSXAttrValue(prop.value);

      // Handle shorthand: { active } where key and value are same identifier
      if (prop.shorthand && t.isIdentifier(prop.value)) {
        attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier(propName),
            t.jsxExpressionContainer(prop.value),
          ),
        );
        continue;
      }

      attributes.push(
        t.jsxAttribute(t.jsxIdentifier(propName), attrValue),
      );
    }
  } else if (calleeName === 'createElement' && propsArg &&
             !t.isNullLiteral(propsArg)) {
    // createElement with non-object, non-null props — can't destructure
    return null;
  }

  // For createElement, children are args[2+] (not inside props)
  if (calleeName === 'createElement' && args.length > 2) {
    children = args.slice(2)
      .map(arg => toJSXChild(arg))
      .filter(Boolean);
  }

  // Build the JSX element
  if (isFragment) {
    if (children.length === 0) {
      return t.jsxFragment(
        t.jsxOpeningFragment(),
        t.jsxClosingFragment(),
        [],
      );
    }
    return t.jsxFragment(
      t.jsxOpeningFragment(),
      t.jsxClosingFragment(),
      children,
    );
  }

  if (children.length === 0) {
    // Self-closing: <Comp prop={val} />
    return t.jsxElement(
      t.jsxOpeningElement(jsxName, attributes, true),
      null,
      [],
      true,
    );
  }

  // With children: <Comp prop={val}>children</Comp>
  // Need a closing element with the same name
  const closingName = isFragment ? null : toJSXName(componentArg);
  return t.jsxElement(
    t.jsxOpeningElement(jsxName, attributes, false),
    t.jsxClosingElement(closingName),
    children,
    false,
  );
}

/**
 * Checks if a node is a (0, fn)(...) comma expression call pattern.
 * Returns the actual function node if so, null otherwise.
 */
function unwrapCommaExpression(node) {
  if (
    t.isSequenceExpression(node) &&
    node.expressions.length === 2 &&
    t.isNumericLiteral(node.expressions[0]) &&
    node.expressions[0].value === 0
  ) {
    return node.expressions[1];
  }
  return null;
}

/**
 * Gets the jsx/jsxs/createElement callee name, handling:
 * - jsx(...)
 * - t.jsx(...)
 * - (0, t.jsx)(...)
 */
function getCalleeName(node) {
  let callee = node.callee;

  // Unwrap (0, expr)
  const unwrapped = unwrapCommaExpression(callee);
  if (unwrapped) callee = unwrapped;

  // Direct call: jsx(...)
  if (t.isIdentifier(callee)) {
    const name = callee.name;
    if (name === 'jsx' || name === 'jsxs' || name === 'createElement' ||
        name === '_jsx' || name === '_jsxs' || name === '_createElement') {
      return name.replace(/^_/, '');
    }
  }

  // Member call: t.jsx(...), React.createElement(...)
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
    const name = callee.property.name;
    if (name === 'jsx' || name === 'jsxs' || name === 'createElement') {
      return name;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Transform a single file
// ---------------------------------------------------------------------------

function transformFile(filePath) {
  const source = readFileSync(filePath, 'utf-8');

  // Quick check: does this file contain jsx/jsxs/createElement calls?
  // Matches: jsx(, jsxs(, _jsx(, _jsxs(, t.jsx(, (0, _jsx)(, createElement(
  // Also matches import { jsx } or import { jsx as _jsx } declarations.
  if (!/(?:jsx|jsxs|createElement)\b/.test(source)) {
    return { code: source, hasJSX: false };
  }

  let ast;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript', 'decorators-legacy', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport'],
    });
  } catch (err) {
    console.error(`  Parse error in ${filePath}: ${err.message}`);
    return { code: source, hasJSX: false, error: true };
  }

  let transformed = false;
  const importsToRemove = new Set();

  // Pass 1: Convert jsx/jsxs/createElement calls to JSX
  // Use exit() so inner calls are converted before outer ones.
  // This ensures that when an outer jsxs() processes its children array,
  // inner jsx() calls have already been replaced with JSXElement nodes,
  // and toJSXChild() can pass them through without wrapping in {}.
  traverse(ast, {
    CallExpression: { exit(path) {
      const calleeName = getCalleeName(path.node);
      if (!calleeName) return;

      const jsxNode = convertCallToJSX(path, calleeName);
      if (jsxNode) {
        path.replaceWith(jsxNode);
        transformed = true;
      }
    }},
  });

  if (!transformed) {
    return { code: source, hasJSX: false };
  }

  // Pass 2: Clean up imports
  // - Remove 'react/jsx-runtime' and 'react/jsx-dev-runtime' entirely
  // - Remove createElement/Fragment from 'react' import if no longer referenced
  traverse(ast, {
    ImportDeclaration(path) {
      const src = path.node.source.value;

      if (src === 'react/jsx-runtime' || src === 'react/jsx-dev-runtime') {
        path.remove();
        return;
      }

      if (src === 'react') {
        // Remove specifiers for createElement/Fragment that are no longer
        // referenced after JSX conversion. We can't rely on babel's scope
        // bindings (reference counts aren't updated after replaceWith), so
        // we collect identifiers still present in the rest of the program.
        const removable = new Set(['createElement', 'Fragment']);
        const remaining = path.node.specifiers.filter(s => {
          if (!t.isImportSpecifier(s) || !removable.has(s.imported.name)) return true;
          const localName = s.local.name;
          // Walk the program body for any remaining reference outside imports
          let stillUsed = false;
          path.parentPath.traverse({
            Identifier(idPath) {
              if (idPath.node.name !== localName) return;
              // Skip identifiers that are part of import specifiers
              if (idPath.parentPath.isImportSpecifier()) return;
              stillUsed = true;
              idPath.stop();
            },
          });
          return stillUsed;
        });

        if (remaining.length === 0) {
          path.remove();
        } else {
          path.node.specifiers = remaining;
        }
      }
    },
  });

  const output = generate(ast, {
    retainLines: false,
    jsescOption: { minimal: true },
    jsonCompatibleStrings: false,
  });

  // Run prettier for proper JSX indentation (if available)
  let code = output.code;
  try {
    const prettierResult = execSync(
      'npx --yes prettier --parser babel --single-quote --trailing-comma all --print-width 100 --jsx-single-quote=false',
      {
        input: code,
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    code = prettierResult;
  } catch {
    // prettier not available — output is still valid, just not perfectly formatted
  }

  return { code, hasJSX: true };
}

// ---------------------------------------------------------------------------
// Process files
// ---------------------------------------------------------------------------

function getOutputPath(inputFile) {
  const dir = outdir || (isInPlace ? dirname(inputFile) : dirname(inputFile));
  const base = basename(inputFile, extname(inputFile));
  return join(dir, base + '.jsx');
}

function processFile(filePath) {
  console.log(`Processing: ${filePath}`);
  const result = transformFile(filePath);

  if (result.error) {
    console.log('  Skipped (parse error)');
    return;
  }

  if (!result.hasJSX) {
    console.log('  No jsx/jsxs/createElement calls found, skipping');
    return;
  }

  if (isDryRun) {
    console.log('--- Output ---');
    console.log(result.code);
    console.log('--- End ---');
    return;
  }

  const outputPath = getOutputPath(filePath);
  if (outdir) {
    mkdirSync(outdir, { recursive: true });
  }

  writeFileSync(outputPath, result.code, 'utf-8');
  console.log(`  → ${outputPath} (${result.code.split('\n').length} lines)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const stat = statSync(inputPath);

if (stat.isDirectory()) {
  const files = readdirSync(inputPath)
    .filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
    .map(f => join(inputPath, f));

  console.log(`Found ${files.length} JS files in ${inputPath}\n`);

  let converted = 0;
  for (const file of files) {
    const result = transformFile(file);
    if (result.hasJSX) {
      if (!isDryRun) {
        const outputPath = getOutputPath(file);
        if (outdir) mkdirSync(outdir, { recursive: true });
        writeFileSync(outputPath, result.code, 'utf-8');
        console.log(`  ${basename(file)} → ${basename(outputPath)}`);
      }
      converted++;
    } else {
      console.log(`  ${basename(file)} — no JSX calls, skipped`);
    }
  }

  console.log(`\nConverted ${converted}/${files.length} files`);
} else {
  processFile(inputPath);
}
