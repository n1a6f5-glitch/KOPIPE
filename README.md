# KOPIPE (コピペ) — Visual Novel Script Localization System

**KOPIPE** is an offline-first Visual Novel script extraction, AI batch translation, polishing/QC, and repack system running entirely in the browser (IndexedDB + Service Worker PWA).

## Supported Engines & Formats
- **Kirikiri / KAG**: `.ks` and `.txt` scripts (Shift-JIS, UTF-8, UTF-16LE)
- **Kirikiri M2 / PSB**: `.scn` compiled binary scenes (plain PSB, dual-key XOR, and MDF zlib-wrapped containers) with 8-stage diagnostic logs and self-verification on repack
- **Artemis Engine**: `.ast` Lua AST scripts (v1 & v2.0) and Artemis `.txt`
- **VNTextPatch**: `.json` (`[{ name, message }]`) arrays

## Key Features
- **VN System Config & Backlog Interface**: Save/Load data slots, Live VN Message Box Preview with speaker nameplate and wrap simulation, and customizable VN character/CG backdrops.
- **One-Click AI Batch Copy-Paste**: Built-in English and Indonesian translation prompts, Markdown code-block auto-stripping, and sticky batch size/range.
- **AI Polish & QC**: Export translated ranges paired with `# JP:` source lines for AI polishing, plus instant cached scanning for untranslated Japanese leftovers, glossary consistency, and tag integrity.
- **22,000+ Line Scale & Folder Workflow**: IndexedDB v2 compound indexes, O(1) project counters, recursive folder import/dry-run, and full tree ZIP repack.

## Development & Verification
```bash
npm install
npm run lint
npm test
```
