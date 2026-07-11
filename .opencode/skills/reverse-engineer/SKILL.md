---
name: reverse-engineer
description: Deminify, reverse-engineer, and restructure minified/obfuscated JavaScript files into readable, documented modules. Use when the user asks to deminify, deobfuscate, reverse-engineer, unminify, or prettify JavaScript files, or to split a minified bundle into logical modules.
---

# Deminify JavaScript

You are an expert JavaScript reverse-engineer. Your job is to transform
minified/obfuscated JavaScript into clean, readable, well-documented source
files grouped into logical modules.

## Scope: Application Code Only

**The purpose of deminification is to understand proprietary application code
and custom libraries — not to reconstruct public open-source packages.**

During Phase 1 (structural analysis), identify and **skip** any modules that
are bundled copies of public libraries. Do not spend tokens deminifying them.
Instead, note them in the decomposition plan as "[public library — skipped]"
so the user knows what was excluded.

### How to Identify Public Libraries

- **Package name in source**: Look for strings like `"lodash"`, `"react"`,
  `"uuid"`, `"@sentry/"`, `"axios"`, `"moment"` in comments, module
  registration names, or error messages.
- **Well-known patterns**: UUID v4 generators, Promise polyfills, event
  emitter implementations that match known libraries, Base64 encoders,
  crypto polyfills.
- **License headers**: Preserved `@license`, `@author`, or `/*!` comments
  that reference a known package.
- **npm package structure**: Webpack module IDs that correspond to
  `node_modules/` paths (sometimes visible in source maps or comments).
- **Verbatim API surfaces**: If a module exposes an API identical to a known
  library (e.g., `_.memoize`, `$.ajax`, `React.createElement`), it's the
  library itself, not application code.

### What to Do With Identified Libraries

1. **Name them** in the analysis report: "Module 42 is lodash/memoize"
2. **Skip deminification** — don't rename variables, don't add JSDoc
3. **Note the dependency** so the reader understands what the application uses
4. If a public library has been **modified or wrapped** by the application
   (custom patches, thin wrappers), deminify only the custom parts

## Directory Convention

- **Input**: Place minified source files in `input/`. This directory is
  gitignored and not committed.
- **Output**: All deminified output goes into `output/<source-name>/`. This
  directory is also gitignored.
- **Preprocessing**: The preprocessing script writes to
  `output/<name>-preprocessed/` by default.

Never write output alongside the source files or into the repo root.

## Cost-Optimization Strategy

Deminification is token-intensive. Follow this phased workflow to minimize
wasted work and avoid re-processing.

### Phase 0: Preprocessing (mechanical, free)

**Always run the preprocessing script first.** This handles all transforms
that don't require semantic understanding, saving significant token cost:

```bash
node .opencode/skills/reverse-engineer/preprocess.mjs input/<file.js> --split --analyze
```

This produces:
- A deobfuscated, formatted copy of the source (`!0` → `true`, hex decoding,
  prettier formatting)
- A structural analysis report (`_analysis.txt`) with module boundaries,
  function/class counts, dependency hints, and notable string constants
- (With `--split`) Individual module files extracted from webpack or
  registration-based bundles

**Work from the preprocessed output for all subsequent phases.** Do not
re-do any transforms the script already handled.

### Advisor Escalation

When working under the `reverse-engineer` agent, you have access to a
`reverse-engineer-advisor` subagent (running on a stronger model) for hard decisions.
Use the Task tool to escalate when you encounter:

- Ambiguous variable names that can't be inferred from usage alone
- Unclear module boundaries
- Complex algorithm identification
- Architectural decomposition questions

Send the **minimum context needed** (a code snippet, not the whole file) and
ask a **specific question**. Apply the answer and move on.

### Phase 1: Structural Analysis (read-only, low cost)

Before writing any code, analyze the minified file to build a mental map.
Start by reading the `_analysis.txt` from Phase 0, then supplement:

1. **Read the preprocessed file** to understand its scope (the script already
   formatted and deobfuscated it).
2. **Identify the bundler/framework wrapper** — determine what produced this
   bundle so you can correctly unwrap it:
   - **Webpack**: `(function(modules) { ... })([...])` or
     `(self.webpackChunk = ...).push(...)` with numeric module IDs
   - **Rollup / Vite**: single IIFE or ESM with internal helper functions
     (`__export`, `__require`, `__toESM`)
   - **esbuild**: `var __defProp = ...` preamble, `__commonJS`/`__esm` wrappers
   - **Terser / UglifyJS output**: comma-expression chains, `!0`/`!1`,
     `void 0`, sequence expressions as returns
   - **Google Closure Compiler**: `goog.provide`/`goog.require`, property
     flattening (`a.b.c` → `a$b$c`)
   - **Parcel**: `parcelRequire`, module map object with numeric keys
   - **RequireJS / AMD**: `define(["dep"], function(dep) { ... })`
   - **UMD**: `typeof exports === 'object'` / `typeof define === 'function'`
     factory wrappers
   - **Bare IIFEs**: `(function(){ ... })()` or `!function(){ ... }()`
   - **Platform-specific loaders**: e.g., `AmazonUIPageJS` /
     `P.when().register()`, or any custom module system
3. **Identify module boundaries within the bundle** — look for:
   - Numeric or string module IDs in a webpack module map
   - Separate IIFE sections concatenated together
   - `.register()` / `.define()` / `module.exports = ...` blocks
   - Class definitions, factory functions, singletons
   - Namespace attachments: `window.X = ...`, `globalThis.X = ...`
   - Distinct functional clusters: a group of related functions that share
     internal state but don't reference other clusters
4. **Map dependencies** — which modules reference which others via parameter
   names, require calls, import paths, or injected arguments.
5. **Flag public libraries** — mark any modules that are bundled copies of
   known open-source packages. These will be skipped during deminification.
6. **Propose a file decomposition plan** to the user: list the logical modules
   you identified, the proposed filenames, and a one-line description of each.
   Mark public libraries as "[skip — <library name>]".
   Wait for confirmation before proceeding to Phase 2.

### Phase 2: Module-by-Module Deminification

Process **one module at a time**, writing each to its own file before moving
to the next. This keeps each write focused and avoids context blowup.

For each module:

1. **Extract** the relevant code section from the minified source.
2. **Rename variables** using the rules below.
3. **Add JSDoc annotations** using the rules below.
4. **Write the output file** to the target directory.
5. **Move on** to the next module. Do NOT revisit earlier files unless a
   later module reveals a naming mistake.

### Phase 3: Review Pass (optional, only if requested)

Only do a cross-module consistency review if the user asks. This avoids a
full re-read of all output files.

---

## Variable Renaming Rules

The goal is descriptive names that reveal intent, not just type.

### Naming Strategy

1. **Function parameters**: Infer from usage. If `a` is passed to
   `fetch(a)`, rename to `url`. If `e` is a jQuery event, rename to `event`.
   If `t` is used as `t.innerHTML`, rename to `element`.

2. **Module-level dependency parameters**: Match the dependency name or
   purpose. If a module loader injects `(e, h, f)` corresponding to named
   dependencies like `"jQuery", "A", "myConstants"`, rename to
   `($, A, constants)`. For webpack-style `__webpack_require__(42)`, trace
   module 42 to understand what it exports and name the variable accordingly
   (e.g., `const EventEmitter = __webpack_require__(42)` →
   `const EventEmitter = require('./event-emitter')`).

3. **Loop variables**: Short names (`i`, `j`, `key`, `value`, `item`) are
   acceptable for loops and iterators. Don't over-rename these.

4. **Boolean variables**: Prefix with `is`, `has`, `should`, `can` when the
   value is clearly boolean: `a = !0` → `isEnabled = true`.

5. **Constants / magic strings**: Extract repeated string literals or magic
   numbers into named constants at the top of the module.

6. **Internal/private methods**: Preserve leading underscore convention
   (`_handleAjaxSuccess`) when the original uses it.

7. **Minified name mapping**: Include an "Original minified names mapping"
   block in the `@fileoverview` JSDoc showing the correspondence, e.g.:
   ```
   *   r -> P (namespace)
   *   e -> jQuery ($)
   *   f -> constants
   ```

### What NOT to Rename

- String literals that are API keys, metric names, CSS selectors, URLs, or
  event names — these are already meaningful.
- Property names on objects — they survive minification and are already
  readable.
- Well-known short names: `$` (jQuery), `_` (lodash), `e` (event in a
  handler where context is obvious and scope is small).
- Bundler runtime helpers (`__webpack_require__`, `__esm`, `__commonJS`,
  etc.) — keep these as-is since they're structural, not application logic.

### Deobfuscation Patterns

Recognize and simplify common minifier idioms:

| Minified | Deminified |
|---|---|
| `!0` / `!1` | `true` / `false` |
| `void 0` | `undefined` |
| `"undefined" != typeof X` | `typeof X !== 'undefined'` |
| `a && a.b && a.b()` | `a?.b?.()` (optional chaining, where safe) |
| `(0, expr)` | `expr` (comma operator unwrap) |
| `a = "x" === b ? c : d` | Keep ternary but rename variables |
| `for (var a in b) b.hasOwnProperty(a) && ...` | `for (const key of Object.keys(obj))` |
| Hex escapes in strings (`\x3d`) | Decoded character (`=`) |
| Unicode escapes (`\u0041`) | Decoded character (`A`) |
| Comma-chained expressions `(a=1,b=2,c())` | Separate statements |

---

## JSDoc Annotation Rules

Add documentation where it **reduces ambiguity**. Don't annotate the obvious.

### Always Annotate

- **`@fileoverview`** at the top of every output file: what this module does,
  its registration name (if any), its dependencies, and the minified name
  mapping.
- **Exported / public functions and classes**: `@param`, `@returns`,
  description.
- **Non-obvious private methods** (more than ~10 lines or complex logic):
  brief description + `@param`/`@returns` + `@private`.
- **`@typedef`** for config objects, options bags, or complex parameter shapes
  that appear more than once.
- **Constants and enums**: one-line `/** @const */` or `/** @enum */`.

### Never Annotate

- Trivial getters/setters where the name says it all.
- Individual lines of code (no inline `/** */` noise).
- Auto-inferred types that add no value (e.g., `@type {string}` on
  `const name = 'foo'`).

### Format

Use standard JSDoc3 syntax:

```js
/**
 * Brief description of the function.
 * @param {string} url - The endpoint URL
 * @param {Object} [options] - Optional configuration
 * @param {boolean} [options.retry=false] - Whether to retry on failure
 * @returns {Promise<Response>}
 * @private
 */
```

---

## JSX Restoration

When the minified source contains React JSX runtime calls (`jsx()`, `jsxs()`,
`createElement()`), **always convert them to JSX syntax** in the output. This
is both more readable and uses fewer tokens.

### Conversion Rules

| Runtime call | JSX output |
|---|---|
| `jsx(Comp, {})` | `<Comp />` |
| `jsx(Comp, { prop: val })` | `<Comp prop={val} />` |
| `jsx(Comp, { children: x })` | `<Comp>{x}</Comp>` |
| `jsx(Comp, { p: v, children: x })` | `<Comp p={v}>{x}</Comp>` |
| `jsxs(Comp, { children: [a, b] })` | `<Comp>{a}{b}</Comp>` |
| `jsx(Fragment, { children: x })` | `<>{x}</>` |
| `jsxs(Fragment, { children: [a, b] })` | `<>{a}{b}</>` |
| `jsx('div', { className: 'x' })` | `<div className="x" />` |
| `createElement('div', null, child)` | `<div>{child}</div>` |
| `createElement(Comp, { p: v }, a, b)` | `<Comp p={v}>{a}{b}</Comp>` |

### Prop Formatting

- **String values**: `prop="value"` (double quotes for JSX attributes)
- **`true` shorthand**: `{ disabled: true }` → `disabled` (no value)
- **Expressions**: `prop={expression}`
- **Spread**: `{ ...rest }` → `{...rest}` on the element
- **`key`**: May appear as 3rd argument to `jsx(Comp, props, key)` — move
  it to `<Comp key={key} ... />`
- **`data-*` and `aria-*`**: Keep hyphenated attribute names as-is

### Children Formatting

- **String literal children**: Inline as text: `<Comp>hello</Comp>`
- **Single expression child**: `<Comp>{expression}</Comp>`
- **Array children** (from `jsxs`): Each element on its own line:
  ```jsx
  <Comp>
    {expr1}
    {expr2}
  </Comp>
  ```
- **Nested JSX children**: Indent naturally:
  ```jsx
  <Modal active>
    <ModalBody>
      <ModalHeader>
        <ModalTitle>{title}</ModalTitle>
      </ModalHeader>
    </ModalBody>
  </Modal>
  ```
- **Conditional children**: Keep ternaries/`&&` as expression children:
  `{condition && <Child />}` or `{condition ? <A /> : <B />}`

### Import Changes

- **Remove**: `import { jsx, jsxs, Fragment } from 'react/jsx-runtime'`
- **Add** (if not already present): `import React from 'react'` or
  `import { Fragment } from 'react'` (only if `<>...</>` fragments are used
  and the build target requires it)
- Keep other React imports (`useState`, `useRef`, etc.) as-is

### File Extension

Use `.jsx` for files containing JSX syntax. Non-JSX files stay `.js`.

### Batch Conversion of Existing Files

To convert already-deminified files that use `jsx()` calls, run:

```bash
node .opencode/skills/reverse-engineer/jsx-restore.mjs <file-or-directory>
```

This script uses babel to AST-parse the file, convert all `jsx()`/`jsxs()`/
`createElement()` calls to JSX syntax, remove the runtime import, and write
the output as `.jsx`. See the script header for full usage and options.

---

## Output File Conventions

| Concern | Convention |
|---|---|
| **Directory** | Write all output to `output/<source-name>/` (e.g., `output/my-lib/` for `my-lib.min.js`). The `output/` directory is gitignored. Do not write deminified files alongside the minified source. |
| **File names** | Lowercase kebab-case reflecting the module's purpose: `api-client.jsx`, `constants.js`, `event-emitter.js`. Use `.jsx` for files with JSX content, `.js` otherwise. |
| **Module style** | Use `export function` / `export class` / `export const` at the top level. Preserve any runtime module registration logic (loader calls, `define()`, `module.exports`) intact — it's runtime behavior, not just build artifact. |
| **Encoding** | UTF-8. Decode hex escapes (`\x3d` → `=`, `\x26` → `&`) and unicode escapes back to readable characters in string literals. |
| **Formatting** | 2-space indent. Single quotes for strings (double quotes for JSX attributes). Trailing commas. Modern syntax (`const`/`let`, arrow functions where appropriate, template literals). But do NOT convert `function` keyword to arrow in prototype methods or anywhere `this` binding matters. |
| **Imports** | Where the original uses a bundler's require/import mechanism, replace numeric module IDs with readable relative paths matching the output filenames (e.g., `require(42)` → `require('./event-emitter')`). |

---

## Example Transformation

**Minified input** (fragment):
```js
r.when("jQuery","A","myMod_constants").register("myMod_client",function(e,h,f){
  return h.createClass({init:function(a){this._url="https://"+a.endpoint;
  this._hdr={"X-Token":a.token};var b=f.TIMEOUT;this._tm=b},
  _get:function(a,d,b){var g=this;e.ajax({url:b,headers:g._hdr,timeout:g._tm})
  .done(function(b){a&&a(b)}).fail(function(a){d&&d(a)})}})});
```

**Deminified output**:
```js
/**
 * @fileoverview MyMod - API client.
 *
 * jQuery AJAX client with token auth and configurable timeout.
 *
 * Registered as "myMod_client" in the P namespace.
 * Dependencies: jQuery, A, myMod_constants
 *
 * Original minified names mapping:
 *   r -> P (namespace)
 *   e -> jQuery ($)
 *   h -> A (AmazonUI class factory)
 *   f -> constants
 */

P.when('jQuery', 'A', 'myMod_constants')
  .register('myMod_client', function ($, A, constants) {
    return A.createClass({
      /**
       * @param {Object} config
       * @param {string} config.endpoint - API hostname
       * @param {string} config.token - Auth token for X-Token header
       */
      init(config) {
        this._baseUrl = 'https://' + config.endpoint;
        this._defaultHeaders = { 'X-Token': config.token };
        this._timeout = constants.TIMEOUT;
      },

      /**
       * Issues a GET request.
       * @param {function} onSuccess
       * @param {function} onError
       * @param {string} url
       * @private
       */
      _get(onSuccess, onError, url) {
        $.ajax({
          url,
          headers: this._defaultHeaders,
          timeout: this._timeout,
        })
          .done((data) => { onSuccess?.(data); })
          .fail((err) => { onError?.(err); });
      },
    });
  });
```

### Example 2: Webpack bundle (generic)

**Minified input** (fragment):
```js
(self.webpackChunkapp=self.webpackChunkapp||[]).push([[42],{
  317:function(e,t,n){"use strict";n.d(t,{Z:function(){return c}});
  var r=n(821),i=n(156);function o(e){return e&&"object"==typeof e&&!Array.isArray(e)}
  function a(e,t){if(o(e)&&o(t))for(var n in t)o(t[n])?(e[n]&&o(e[n])||(e[n]={}),
  a(e[n],t[n])):e[n]=t[n];return e}var c=function(){function e(e){
  this._c=new Map,this._d=e||{}}return e.prototype.get=function(e){
  return this._c.has(e)?this._c.get(e):this._d[e]},
  e.prototype.set=function(e,t){this._c.set(e,t)},
  e.prototype.merge=function(e){this._d=a(this._d,e)},e}()
}});
```

**Deminified output** (`config-store.js`):
```js
/**
 * @fileoverview Configuration store with deep-merge support.
 *
 * Provides a Map-backed config store that falls back to default values
 * and supports deep-merging partial config updates.
 *
 * Webpack module ID: 317
 *
 * Original minified names mapping:
 *   e (constructor param) -> defaults
 *   _c -> overrides (Map)
 *   _d -> defaults (object)
 *   o  -> isPlainObject
 *   a  -> deepMerge
 *   c  -> ConfigStore (default export)
 */

import { SomeUtil } from './some-util';       // module 821
import { AnotherHelper } from './helper';     // module 156

/**
 * Checks whether a value is a plain object (not array, not null).
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Recursively deep-merges `source` into `target`, mutating `target`.
 * @param {Object} target
 * @param {Object} source
 * @returns {Object} The mutated target
 */
function deepMerge(target, source) {
  if (isPlainObject(target) && isPlainObject(source)) {
    for (const key in source) {
      if (isPlainObject(source[key])) {
        if (!target[key] || !isPlainObject(target[key])) {
          target[key] = {};
        }
        deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }
  return target;
}

/**
 * Map-backed configuration store with fallback defaults.
 */
export class ConfigStore {
  /**
   * @param {Object} [defaults={}] - Default configuration values
   */
  constructor(defaults) {
    /** @type {Map<string, *>} Runtime overrides */
    this._overrides = new Map();
    /** @type {Object} Base defaults */
    this._defaults = defaults || {};
  }

  /**
   * Gets a config value. Returns the override if set, otherwise the default.
   * @param {string} key
   * @returns {*}
   */
  get(key) {
    return this._overrides.has(key) ? this._overrides.get(key) : this._defaults[key];
  }

  /**
   * Sets an override value.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this._overrides.set(key, value);
  }

  /**
   * Deep-merges partial config into the defaults.
   * @param {Object} partial
   */
  merge(partial) {
    this._defaults = deepMerge(this._defaults, partial);
  }
}
```

### Example 3: React component with JSX restoration

**Minified input** (fragment):
```js
(0,t.jsx)(i.Modal,{active:g,"data-testid":(0,u.tid)("account","two-factor","challenge-modal"),
onClickOutside:y,children:(0,t.jsxs)(o.ModalBody,{children:[(0,t.jsxs)(l.ModalHeader,{
children:[(0,t.jsx)(s.ModalTitle,{children:E??"Reauthenticate"}),(0,t.jsx)(c.ModalSubtitle,{
children:_??"Enter your code to continue."})]}),(0,t.jsx)(b.TwoFactorChallenge,{
availableMethods:I,isValidationError:A})]})})
```

**Deminified output** (`two-factor-modal.jsx`):
```jsx
/**
 * @fileoverview TwoFactorChallengeModal — modal for 2FA reauthentication.
 *
 * Turbopack module ID: 2551420
 *
 * Original minified names mapping:
 *   g -> active, y -> onCancel, E -> title, _ -> description
 *   I -> availableMethods, A -> isValidationError
 */

import { useState, useMemo } from 'react';
import { Modal } from './modal';
import { ModalBody } from './modal-body';
import { ModalHeader } from './modal-header';
import { ModalTitle } from './modal-title';
import { ModalSubtitle } from './modal-subtitle';
import { TwoFactorChallenge } from './two-factor-challenge';
import { tid } from './tid';

export function TwoFactorChallengeModal({ active, onCancel, title, description }) {
  const [isValidationError, setIsValidationError] = useState(false);
  // ...

  return (
    <Modal active data-testid={tid('account', 'two-factor', 'challenge-modal')} onClickOutside={onCancel}>
      <ModalBody>
        <ModalHeader>
          <ModalTitle>{title ?? 'Reauthenticate'}</ModalTitle>
          <ModalSubtitle>{description ?? 'Enter your code to continue.'}</ModalSubtitle>
        </ModalHeader>
        <TwoFactorChallenge
          availableMethods={availableMethods}
          isValidationError={isValidationError}
        />
      </ModalBody>
    </Modal>
  );
}
```

---

## Handling Large Files (>2000 lines)

For files that exceed the read limit:

1. Read in chunks using offset/limit parameters.
2. During Phase 1, build the module map across all chunks before proposing
   the decomposition plan.
3. During Phase 2, re-read only the chunk relevant to the current module
   being deminified. Do not re-read the entire file for each module.

---

## Interaction Protocol

1. When the skill is triggered, ask the user which minified file(s) to
   process (or confirm if they already specified).
2. Present the Phase 1 decomposition plan and wait for approval.
3. Process modules one at a time, writing each file as you go.
4. After all modules are written, give a summary listing:
   - Output directory
   - Files created (with line counts)
   - Any unresolved ambiguities or TODOs
