import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "lib/rag/liveRetrievalEval.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, RAG_LIVE_EVAL: "true" },
  },
);

process.exit(result.status ?? 1);
