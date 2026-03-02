const variations = [
  { name: "v1-clean-minimal", port: 3001 },
  { name: "v2-split-panel", port: 3002 },
  { name: "v3-immersive-gallery", port: 3003 },
];

const procs = variations.map((v) =>
  Bun.spawn(["bun", "--hot", "index.ts"], {
    cwd: `${import.meta.dir}/variations/${v.name}`,
    env: { ...process.env, PORT: String(v.port) },
    stdout: "inherit",
    stderr: "inherit",
  }),
);

process.on("SIGINT", () => {
  for (const p of procs) p.kill();
  process.exit();
});

process.on("SIGTERM", () => {
  for (const p of procs) p.kill();
  process.exit();
});

console.log("\nAll variations launching:");
for (const v of variations) {
  console.log(`  ✦ ${v.name} → http://localhost:${v.port}`);
}

await Promise.all(procs.map((p) => p.exited));
