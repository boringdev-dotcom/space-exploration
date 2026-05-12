Drop a CC0/CC-BY spacecraft cockpit GLB at this path named spacecraft_cockpit.glb.

**Deploy (Render / Docker):** This file must be **committed and pushed** to the branch your service builds from. The production image is built with `npm run build`, which only copies what exists in the repo at build time (~30 MB binary). If the GLB is missing from Git (or Git LFS isn’t pulling binaries on the build machine), the request returns HTML (SPA fallback) instead of a model and the cockpit load fails.
