# Copilot instructions

## What this repo is

An [Obsidian](https://obsidian.md) community plugin that lets you reference Azure DevOps work
items inline in notes. A reference is stored as an ordinary markdown link and rendered as a rich
chip in Reading view and Live Preview. See `README.md` for user-facing behaviour.

TypeScript, bundled with esbuild into a single `main.js` at the repo root. `main.js` is generated
and git-ignored — never edit it, and never commit it.

## Commands

```bash
npm install       # install dependencies
npm run dev       # esbuild watch build
npm run typecheck # tsc --noEmit
npm run lint      # ESLint
npm run lint:fix  # ESLint with autofix
npm run build     # typecheck + production bundle
```

There is no test suite. Verification is typecheck + lint + build, plus manual testing in a vault
(symlink or copy the repo into `<vault>/.obsidian/plugins/azure-devops-workitems/`).

## Definition of done

**`npm run lint` must pass with zero errors before any change is considered complete.** Run it
after every change to `src/`, `*.mjs`, or `eslint.config.js`. Do not finish a task, hand work back,
or open a pull request while ESLint is reporting errors.

Also required:

- `npm run build` passes (this runs `tsc --noEmit` first, so it covers type checking).
- Warnings introduced by your change are fixed too, not just errors.
- Suppressions (`eslint-disable`) are a last resort. If you add one, scope it to a single line and
  append a `--` comment explaining why, as done in `src/auth/cliProvider.ts`.

## Layout

```
src/main.ts             plugin entry: lifecycle, settings, commands, paste handling
src/settings.ts         settings tab + DEFAULT_SETTINGS
src/suggest.ts          EditorSuggest for the `az#` trigger
src/suggestionRow.ts    DOM for one suggestion row
src/modal.ts            command palette work item picker
src/signInModal.ts      Entra sign-in progress dialog
src/chip.ts             builds the rendered chip element
src/hover.ts            hover preview card
src/reference.ts        work item link detection/normalisation
src/searchDebouncer.ts  debounce + de-duplication for search
src/render/            Reading view postprocessor and Live Preview CodeMirror extension
src/azdo/              Azure DevOps REST client, response types, TTL cache
src/auth/              PAT, Microsoft Entra (PKCE) and Azure CLI auth providers
styles.css              all plugin styling
manifest.json           Obsidian plugin manifest
versions.json           minAppVersion per plugin version
```

## Conventions

- Tabs for indentation, double-quoted strings, semicolons — match the surrounding file.
- Type-only imports use inline `type` (`import { foo, type Bar } from "..."`); ESLint enforces this.
- Comments explain *why*, not *what*. The existing code is deliberately sparse on comments; keep it
  that way.
- Use British spelling in comments and identifiers where the codebase already does (`normalise`,
  `colour`).
- Prefer explicit return types on exported functions and public methods.

## Obsidian plugin rules

This plugin is aimed at the community catalogue, so its review rules apply:

- Build DOM with Obsidian's `createEl` / `createDiv` / `createSpan` helpers. Never assign
  `innerHTML` / `outerHTML` or use `insertAdjacentHTML`.
- Put styling in `styles.css` and toggle CSS classes. Inline `style` is only acceptable for
  genuinely dynamic values (positioning, `--azdo-*` custom properties carrying API colours).
- Register everything through the plugin (`registerEvent`, `registerDomEvent`, `registerInterval`,
  `registerEditorExtension`) so it is torn down automatically, and clean up anything else in
  `onunload()`.
- Command names are sentence case and must not repeat the plugin name.
- The settings tab is declarative: implement `getSettingDefinitions()` and never add a `display()`
  method back. Rows that need custom widgets use a `render` callback; `this.update()` re-renders.
- Do not `console.log`; use `logError` / `reportError` in `main.ts` for failures.
- Desktop-only code paths are guarded with `Platform.isDesktopApp`, except the guard immediately
  around the lazy `require("child_process")` in `src/auth/cliProvider.ts`, which must stay
  `Platform.isDesktop` — the `obsidianmd/no-nodejs-modules` rule only recognises that spelling, and
  only as the first statement of the enclosing function.
- `npm run lint` runs `eslint-plugin-obsidianmd`, the same ruleset as the community catalogue's
  automated review. `tsconfig.json` sets `"types": []` on purpose: the scanner type-checks without
  `@types/node`, so referencing Node's ambient types would produce `no-unsafe-*` findings there but
  not locally.

## Azure DevOps API

- All HTTP goes through Obsidian's `requestUrl`, never `fetch` — this avoids CORS restrictions.
- Search is WIQL (`POST _apis/wit/wiql`) followed by a batched `GET _apis/wit/workitems`; keep
  requests batched rather than per work item.
- Results are cached in `TtlCache` and in-flight requests are de-duplicated. Preserve both when
  changing the client.
- Ids are resolved at organization scope so references survive a work item moving project.
- PATs are sent as HTTP basic auth; Entra and Azure CLI tokens as bearer. A rejected bearer token is
  discarded and re-acquired once before the error surfaces.
- Support both Azure DevOps Services and Azure DevOps Server (on-premises collection URLs).

## Security

- Never log or echo tokens, PATs, refresh tokens or authorization codes.
- Never commit `data.json` — it holds user credentials.
- The Entra flow is authorization code + PKCE with no client secret; keep it that way.

## Releases

`manifest.json` and `versions.json` are updated by `npm version` via `version-bump.mjs`. Pushing a
tag triggers `.github/workflows/release.yml`, which lints, builds and drafts a GitHub release with
`main.js`, `manifest.json` and `styles.css`. Bump `minAppVersion` only when a newer Obsidian API is
actually required.
