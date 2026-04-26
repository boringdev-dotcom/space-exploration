/**
 * One-time generator that calls the World Labs Marble API to produce
 * a Gaussian-splat world per destination, then rewrites
 * `src/data/planets.ts` with the resulting SPZ URLs.
 *
 * Usage:
 *   tsx scripts/generate-worlds.ts             # uses WLT_API_KEY from .env.local
 *   tsx scripts/generate-worlds.ts --mock      # seeds public Spark sample SPZs
 *   tsx scripts/generate-worlds.ts --only luna # generate one planet
 *
 * API reference: https://docs.worldlabs.ai/api
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PLANETS, type Planet } from "../src/data/planets.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PLANETS_PATH = resolve(ROOT, "src/data/planets.ts");
const ENV_LOCAL = resolve(ROOT, ".env");

const API_BASE = "https://api.worldlabs.ai/marble/v1";
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const MODEL = "marble-1.1 plus";

/**
 * Public Spark sample splats — used by --mock to give us something
 * runnable end-to-end before any API key is provisioned.
 */
const MOCK_SPLATS: Record<string, string> = {
  luna: "https://sparkjs.dev/assets/splats/butterfly.spz",
  mars: "https://sparkjs.dev/assets/splats/butterfly.spz",
  europa: "https://sparkjs.dev/assets/splats/butterfly.spz",
  titan: "https://sparkjs.dev/assets/splats/butterfly.spz",
};

interface Args {
  mock: boolean;
  only?: string;
}

interface MarbleOperation {
  operation_id?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: {
    assets?: {
      splats?: {
        spz_urls?: {
          full_res?: string;
          "500k"?: string;
          "100k"?: string;
        };
      };
    };
  };
}

interface MarbleGenerateResponse {
  operation_id: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const mock = args.includes("--mock");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
  return { mock, only };
}

async function loadEnv(): Promise<void> {
  if (!existsSync(ENV_LOCAL)) return;
  const content = await readFile(ENV_LOCAL, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

async function startWorldGen(planet: Planet, apiKey: string): Promise<string> {
  const res = await fetch(`${API_BASE}/worlds:generate`, {
    method: "POST",
    headers: {
      "WLT-Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      display_name: `Spark Odyssey · ${planet.name}`,
      model: MODEL,
      world_prompt: {
        type: "text",
        text_prompt: planet.prompt,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[${planet.id}] Marble generate failed (${res.status}): ${body}`,
    );
  }

  const data = (await res.json()) as MarbleGenerateResponse;
  if (!data.operation_id) {
    throw new Error(`[${planet.id}] Missing operation_id in response`);
  }
  return data.operation_id;
}

async function pollOperation(
  operationId: string,
  apiKey: string,
  planetId: string,
): Promise<MarbleOperation> {
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    attempt++;
    const res = await fetch(`${API_BASE}/operations/${operationId}`, {
      headers: { "WLT-Api-Key": apiKey },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `[${planetId}] poll failed (${res.status}): ${body}`,
      );
    }
    const op = (await res.json()) as MarbleOperation;

    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    if (op.done) {
      console.log(`  [${planetId}] done after ${elapsed}s (${attempt} polls)`);
      return op;
    }
    console.log(`  [${planetId}] still generating… ${elapsed}s elapsed`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`[${planetId}] timed out waiting for world generation`);
}

function pickSplatUrl(op: MarbleOperation): string {
  const urls = op.response?.assets?.splats?.spz_urls;
  if (!urls) throw new Error("Operation completed but produced no splat URLs");
  return urls.full_res ?? urls["500k"] ?? urls["100k"] ?? "";
}

async function rewritePlanetsFile(updates: Record<string, string>): Promise<void> {
  const original = await readFile(PLANETS_PATH, "utf8");

  let result = original;
  for (const [id, url] of Object.entries(updates)) {
    // Find the planet block and replace its splatUrl line.
    const planetBlockRe = new RegExp(
      String.raw`(id:\s*"${id}"[\s\S]*?splatUrl:\s*)"[^"]*"`,
      "m",
    );
    if (!planetBlockRe.test(result)) {
      console.warn(`Could not find splatUrl for ${id}; skipping rewrite.`);
      continue;
    }
    result = result.replace(planetBlockRe, `$1"${url}"`);
  }

  await writeFile(PLANETS_PATH, result, "utf8");
  console.log(`✓ Wrote ${Object.keys(updates).length} URLs to src/data/planets.ts`);
}

async function main(): Promise<void> {
  await loadEnv();
  const { mock, only } = parseArgs();

  const targets = only
    ? PLANETS.filter((p) => p.id === only)
    : PLANETS;
  if (targets.length === 0) {
    throw new Error(`No planets matched --only=${only ?? ""}`);
  }

  if (mock) {
    console.log("Mock mode: seeding public Spark sample SPZs.\n");
    const updates: Record<string, string> = {};
    for (const p of targets) {
      const url = MOCK_SPLATS[p.id] ?? MOCK_SPLATS.luna;
      updates[p.id] = url;
      console.log(`  ${p.id} -> ${url}`);
    }
    await rewritePlanetsFile(updates);
    return;
  }

  const apiKey = process.env.WLT_API_KEY;
  if (!apiKey) {
    console.error(
      "WLT_API_KEY missing. Add it to .env.local or run with --mock.",
    );
    process.exit(1);
  }

  console.log(
    `Generating ${targets.length} world(s) with model ${MODEL}.\n` +
      "Each world takes ~5 minutes. Be patient.\n",
  );

  const updates: Record<string, string> = {};
  for (const planet of targets) {
    console.log(`→ ${planet.name} (${planet.id})`);
    try {
      const opId = await startWorldGen(planet, apiKey);
      console.log(`  operation_id: ${opId}`);
      const op = await pollOperation(opId, apiKey, planet.id);
      if (op.error) {
        throw new Error(
          `Marble error: ${op.error.message ?? JSON.stringify(op.error)}`,
        );
      }
      const url = pickSplatUrl(op);
      updates[planet.id] = url;
      console.log(`  splat URL: ${url}\n`);
    } catch (err) {
      console.error(`  ✗ ${(err as Error).message}\n`);
    }
  }

  if (Object.keys(updates).length > 0) {
    await rewritePlanetsFile(updates);
  } else {
    console.log("No worlds generated successfully.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
