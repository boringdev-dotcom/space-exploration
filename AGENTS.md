# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Interstellar Spark Odyssey is a **frontend-only** Vite + Three.js + Spark.js application (no backend, no database). It is a 3D space-flight simulator that uses Gaussian-splat rendering for planetary surfaces.

### Running the app

- **Dev server**: `npm run dev` (Vite on port 5173)
- **Typecheck (lint equivalent)**: `npm run typecheck`
- **Build**: `npm run build` (runs tsc + vite build)
- See `package.json` scripts for the full list.

### Mock data seeding

Before the app can render destination surfaces, the splat URL data files must be populated. Run these once after a fresh clone (no API key needed):

```bash
npm run worlds:mock
npm run cockpits:mock
npm run backdrops:mock
```

These write to `src/data/planets.ts`, `src/data/cockpits.ts`, and `src/data/backdrops.ts` respectively. The mock commands use public Spark sample SPZ URLs; no `WLT_API_KEY` is required.

### Gotchas

- The project requires **Node.js 22** (per Dockerfile spec). Ensure node v22.x is available.
- There is no ESLint config — the only lint-like check is `npm run typecheck` (TypeScript strict mode with `noUnusedLocals` / `noUnusedParameters`).
- There are no automated test suites (no Jest, Vitest, etc.). Validation is done via typecheck + visual testing in browser.
- The Vite dev server binds to `0.0.0.0` (`host: true` in vite.config.ts), accessible at `http://localhost:5173`.
- The 3D scene requires WebGL 2.0. In headless/CI environments, use a browser with GPU support or expect rendering limitations.
- The app uses a state machine (`SceneManager`) that auto-advances through scenes. If you need to test a specific scene, you may need to reload the page to reset state (state is not persisted in localStorage by default, but in-memory state can persist across HMR updates).
