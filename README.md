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
input/          # Optional scratch space (gitignored). A local path does not have to live here.
output/         # capture.json and deminified files land here (gitignored)
.opencode/
  agents/
    reverse-engineer.md          # Primary agent (GLM-Z1 Rumination, 200 steps)
    reverse-engineer-advisor.md  # Advisor subagent (Claude Opus, read-only)
  skills/
    reverse-engineer/
      SKILL.md         # Detailed workflow, rules, and examples
      capture.mjs      # Fetches a page URL or local file and writes capture.json
      preprocess.mjs   # Mechanical preprocessing. capture.mjs runs this per script.
      jsx-restore.mjs  # Batch JSX restoration for already-deminified files
      tests/           # Test suite for the scripts
```

## Quickstart

Pass a page URL to `capture.mjs`. A local `.js` path works the same way, and it does not need to sit in `input/`.

```bash
node .opencode/skills/reverse-engineer/capture.mjs https://app.example.com/dashboard
node .opencode/skills/reverse-engineer/capture.mjs path/to/bundle.js
```

The command writes `output/<captureId>/capture.json`. Open OpenCode and ask it to reverse-engineer that page or file. The `reverse-engineer` agent reads the manifest, proposes a module decomposition plan, and writes deminified files into the directories `capture.json` names.

## Preprocessing script

`capture.mjs` runs this on each script it keeps:

```bash
node .opencode/skills/reverse-engineer/preprocess.mjs <file.js> --outdir <dir> --split
```

Flags:
- `--split` extracts individual modules into separate files
- `--analyze` prints the structural report the script also writes to `_analysis.txt`
- `--no-format` skips prettier

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

- Deminified files go in the `deminifiedDir` recorded for each ready asset in `capture.json` (under `output/<captureId>/`, gitignored)
- Filenames: lowercase kebab-case (`api-client.jsx`, `event-emitter.js`)
- `.jsx` extension for files containing JSX, `.js` otherwise
- 2-space indent, single quotes, trailing commas, modern syntax
- Each file includes a `@fileoverview` JSDoc with a minified-name mapping
