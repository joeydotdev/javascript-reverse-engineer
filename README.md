# reverse

An OpenCode workspace for reverse-engineering minified and obfuscated JavaScript bundles into clean, readable, well-documented source files.

## What it does

- Deobfuscates mechanical minifier patterns (`!0` → `true`, hex/unicode escapes, comma chains)
- Splits webpack, Rollup, esbuild, Parcel, and custom bundles into individual module files
- Renames single-letter variables to descriptive names based on usage
- Adds JSDoc annotations (`@fileoverview`, `@param`, `@returns`, `@typedef`)
- Restores React JSX syntax from `jsx()`/`jsxs()`/`createElement()` runtime calls
- Identifies and skips bundled copies of public open-source libraries (lodash, React, etc.)
- Escalates hard naming/boundary decisions to a stronger advisor model

## Directory layout

```
input/          # Drop minified source files here (gitignored)
output/         # Deminified output lands here (gitignored)
.opencode/
  agents/
    reverse-engineer.md          # Primary agent (GLM-Z1 Rumination, 200 steps)
    reverse-engineer-advisor.md  # Advisor subagent (Claude Opus, read-only)
  skills/
    reverse-engineer/
      SKILL.md         # Detailed workflow, rules, and examples
      preprocess.mjs   # Mechanical preprocessing script (run first)
      jsx-restore.mjs  # Batch JSX restoration for already-deminified files
      tests/           # Test suite for the scripts
```

## Quickstart

1. Drop a minified `.js` file into `input/`.
2. Open OpenCode and describe what you want, e.g.:
   - "Reverse-engineer `input/bundle.js`"
   - "Deminify `input/app.min.js` and split it into modules"
3. The `reverse-engineer` agent activates automatically, runs the preprocessor, proposes a module decomposition plan, and writes output to `output/<name>/`.

## Preprocessing script

Run this manually before starting if you want to inspect the structure first:

```bash
node .opencode/skills/reverse-engineer/preprocess.mjs input/<file.js> --split --analyze
```

Flags:
- `--split` — extract individual modules into separate files
- `--analyze` — generate a `_analysis.txt` structural report

Output goes to `output/<name>-preprocessed/` by default.

## JSX restoration

To batch-convert already-deminified files that still use `jsx()` call form:

```bash
node .opencode/skills/reverse-engineer/jsx-restore.mjs <file-or-directory>
```

## Agent architecture

The workspace uses a two-agent setup to balance cost and quality:

| Agent | Model | Role |
|---|---|---|
| `reverse-engineer` | GLM-5.2 | Primary workhorse — preprocesses, analyzes, and deminifies |
| `reverse-engineer-advisor` | Claude Opus | Advisory only — called for hard naming, boundary, and algorithm decisions |

The advisor is read-only (no edit/bash access) and is invoked via the Task tool with minimum context snippets to keep token costs low.

## Output conventions

- Files go in `output/<source-name>/` (gitignored)
- Filenames: lowercase kebab-case (`api-client.jsx`, `event-emitter.js`)
- `.jsx` extension for files containing JSX, `.js` otherwise
- 2-space indent, single quotes, trailing commas, modern syntax
- Each file includes a `@fileoverview` JSDoc with a minified-name mapping
