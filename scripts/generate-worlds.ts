/**
 * One-time generator that calls the World Labs Marble API to produce
 * a Gaussian-splat world per record in one of three tables, then rewrites
 * the corresponding data file with the resulting SPZ URLs.
 *
 * Usage:
 *   tsx scripts/generate-worlds.ts                       # planets (default)
 *   tsx scripts/generate-worlds.ts --table cockpits      # interior cockpits
 *   tsx scripts/generate-worlds.ts --table backdrops     # static backdrops
 *   tsx scripts/generate-worlds.ts --mock                # seed Spark sample SPZs
 *   tsx scripts/generate-worlds.ts --only luna           # generate one record
 *
 * API reference: https://docs.worldlabs.ai/api
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PLANETS } from "../src/data/planets.ts";
import { COCKPITS } from "../src/data/cockpits.ts";
import { BACKDROPS } from "../src/data/backdrops.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENV_LOCAL = resolve(ROOT, ".env");

const API_BASE = "https://api.worldlabs.ai/marble/v1";
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const MODEL = "marble-1.1";

/** Public Spark sample splat used by --mock to populate every record. */
const MOCK_SPLAT = "https://sparkjs.dev/assets/splats/butterfly.spz";

type TableName = "planets" | "cockpits" | "backdrops";

interface Record {
  id: string;
  name: string;
  prompt: string;
  splatUrl: string;
}

interface TableSpec {
  name: TableName;
  records: Record[];
  filePath: string;
  /** Display label for log lines. */
  label: string;
}

const TABLES: Record_<TableName, TableSpec> = {
  planets: {
    name: "planets",
    records: PLANETS as Record[],
    filePath: resolve(ROOT, "src/data/planets.ts"),
    label: "Planet",
  },
  cockpits: {
    name: "cockpits",
    records: COCKPITS as Record[],
    filePath: resolve(ROOT, "src/data/cockpits.ts"),
    label: "Cockpit",
  },
  backdrops: {
    name: "backdrops",
    records: BACKDROPS as Record[],
    filePath: resolve(ROOT, "src/data/backdrops.ts"),
    label: "Backdrop",
  },
};

// `Record` is shadowed above for our domain; alias the TS built-in.
type Record_<K extends string, V> = { [P in K]: V };

interface Args {
  mock: boolean;
  only?: string;
  table: TableName;
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
  const tableIdx = args.indexOf("--table");
  const table = (tableIdx >= 0 ? args[tableIdx + 1] : "planets") as TableName;
  if (!["planets", "cockpits", "backdrops"].includes(table)) {
    throw new Error(`Unknown --table value: ${table}`);
  }
  return { mock, only, table };
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

async function startWorldGen(record: Record, apiKey: string, label: string): Promise<string> {
  const res = await fetch(`${API_BASE}/worlds:generate`, {
    method: "POST",
    headers: {
      "WLT-Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      display_name: `Spark Odyssey · ${label} · ${record.name}`,
      model: MODEL,
      world_prompt: {
        type: "text",
        text_prompt: record.prompt,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[${record.id}] Marble generate failed (${res.status}): ${body}`,
    );
  }

  const data = (await res.json()) as MarbleGenerateResponse;
  if (!data.operation_id) {
    throw new Error(`[${record.id}] Missing operation_id in response`);
  }
  return data.operation_id;
}

async function pollOperation(
  operationId: string,
  apiKey: string,
  recordId: string,
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
        `[${recordId}] poll failed (${res.status}): ${body}`,
      );
    }
    const op = (await res.json()) as MarbleOperation;

    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    if (op.done) {
      console.log(`  [${recordId}] done after ${elapsed}s (${attempt} polls)`);
      return op;
    }
    console.log(`  [${recordId}] still generating… ${elapsed}s elapsed`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`[${recordId}] timed out waiting for world generation`);
}

function pickSplatUrl(op: MarbleOperation): string {
  const urls = op.response?.assets?.splats?.spz_urls;
  if (!urls) throw new Error("Operation completed but produced no splat URLs");
  return urls.full_res ?? urls["500k"] ?? urls["100k"] ?? "";
}

async function rewriteSplatUrls(
  filePath: string,
  updates: Record_<string, string>,
): Promise<void> {
  const original = await readFile(filePath, "utf8");

  let result = original;
  for (const [id, url] of Object.entries(updates)) {
    const blockRe = new RegExp(
      String.raw`(id:\s*"${id}"[\s\S]*?splatUrl:\s*)"[^"]*"`,
      "m",
    );
    if (!blockRe.test(result)) {
      console.warn(`Could not find splatUrl for ${id}; skipping rewrite.`);
      continue;
    }
    result = result.replace(blockRe, `$1"${url}"`);
  }

  await writeFile(filePath, result, "utf8");
  console.log(
    `✓ Wrote ${Object.keys(updates).length} URL(s) to ${filePath.replace(ROOT + "/", "")}`,
  );
}

async function main(): Promise<void> {
  await loadEnv();
  const { mock, only, table } = parseArgs();
  const spec = TABLES[table];
  if (!spec) throw new Error(`Unknown table: ${table}`);

  const targets = only
    ? spec.records.filter((p) => p.id === only)
    : spec.records;
  if (targets.length === 0) {
    throw new Error(`No ${spec.label.toLowerCase()}s matched --only=${only ?? ""}`);
  }

  if (mock) {
    console.log(`Mock mode: seeding public Spark sample SPZs (${spec.name}).\n`);
    const updates: Record_<string, string> = {};
    for (const p of targets) {
      updates[p.id] = MOCK_SPLAT;
      console.log(`  ${p.id} -> ${MOCK_SPLAT}`);
    }
    await rewriteSplatUrls(spec.filePath, updates);
    return;
  }

  const apiKey = process.env.WLT_API_KEY;
  if (!apiKey) {
    console.error(
      "WLT_API_KEY missing. Add it to .env / .env.local or run with --mock.",
    );
    process.exit(1);
  }

  console.log(
    `Generating ${targets.length} ${spec.label.toLowerCase()} world(s) with model ${MODEL}.\n` +
      "Each world takes ~5 minutes. Be patient.\n",
  );

  const updates: Record_<string, string> = {};
  for (const record of targets) {
    console.log(`→ ${record.name} (${record.id})`);
    try {
      const opId = await startWorldGen(record, apiKey, spec.label);
      console.log(`  operation_id: ${opId}`);
      const op = await pollOperation(opId, apiKey, record.id);
      if (op.error) {
        throw new Error(
          `Marble error: ${op.error.message ?? JSON.stringify(op.error)}`,
        );
      }
      const url = pickSplatUrl(op);
      updates[record.id] = url;
      console.log(`  splat URL: ${url}\n`);
    } catch (err) {
      console.error(`  ✗ ${(err as Error).message}\n`);
    }
  }

  if (Object.keys(updates).length > 0) {
    await rewriteSplatUrls(spec.filePath, updates);
  } else {
    console.log("No worlds generated successfully.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
