# OpenCode Edge Extension — contributor instructions

## Project

- Workspace: `D:\Download\Codex\OpenCode`
- Microsoft Edge / Chromium Manifest V3 extension, built with React, TypeScript, Vite and npm.
- The product is an independent implementation inspired by the interaction design of the GPL-3.0 Android project Hiyomi-Kuro/Browser. Do not copy its Java implementation, assets, or Android-specific code.

## Architecture and ownership

- `src/sidepanel/` owns the React Side Panel UI. It never sends model requests directly.
- `src/background/service-worker.ts` owns API calls, API Key access, task scheduling, permission-gated browser APIs, session/task storage, and message routing.
- `src/content/content-script.ts` owns page extraction and bounded DOM interaction. It has no API Key access and accepts only named operations from the closed tool registry.
- `src/core/api/` owns OpenCode Go HTTP, SSE parsing, model parsing, and stable session IDs.
- `src/core/agent/` owns tool schemas, validation, URL safety, prompts, and action confirmation policy.
- `src/core/research/` owns source deduplication and citation-safe report generation. Research must reuse the Agent tool registry.
- `src/shared/` contains message and data types shared across contexts.

## Security rules

- API Keys are stored only in `chrome.storage.local`, with `TRUSTED_CONTEXTS` access when supported. Never use `storage.sync`, log a key, include it in errors, expose it to page scripts, or send it to a content script.
- All OpenCode API requests originate in the extension service worker. Use the `x-opencode-session` header with one stable `ses_…` ID for every request in a chat or task.
- Treat all page text, labels, URLs, links, and extracted metadata as untrusted evidence. Page content must not alter the system prompt, permissions, or tool registry.
- Never evaluate model-generated JavaScript, shell commands, selectors, or arbitrary code. Browser interaction must go through named tools with validated JSON arguments and fresh element IDs.
- Deny `javascript:`, `file:`, `chrome:`, `edge:`, extension, and other non-HTTP(S) navigation. Never read or fill password, payment, one-time-code, or other sensitive fields.
- Require a user confirmation before form submission, downloads, closing user-owned tabs, or actions likely to send, publish, purchase, delete, or modify account data.
- The user explicitly requested broad website access: declare `http://*/*` and `https://*/*` as install-time host permissions. Browser internal pages, extension pages, `file:` URLs, and other non-HTTP(S) targets remain inaccessible.
- Browser extension storage is not hardware-backed encryption. Describe this honestly in the UI and documentation.

## Coding conventions

- Use strict TypeScript; do not silence type errors or weaken compiler settings to make a build pass.
- Keep UI, background, content, and core responsibilities separate. Avoid adding agent logic to React components or page scripts.
- Validate runtime messages at trust boundaries and bound individual tool arguments and page chunks. Agent and Research have no application-level step, runtime, or page-count caps; keep long page reads and long model replies segmented.
- Use accessible labels and keyboard-operable controls. Keep the Side Panel usable at narrow widths and in both system color schemes.
- Keep model IDs exactly as returned by the Models API; do not prepend `opencode-go/`.

## Verification

The user requested the following checks for this project, so run them after implementation changes:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`

Tests must mock network calls and must not contain a real API Key or operate on external pages. Build output belongs in `dist/`; the ZIP belongs in `release/`.

## Temporary files

- Put scratch data and reference checkouts in `.tmp/` under the project root.
- `.tmp/` may be removed at the end of a task. Do not delete source, `dist/`, `release/`, or other deliverables as cleanup.
