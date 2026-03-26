const res = await fetch("http://localhost:8000/health");
const health = await res.json();

if (health.status !== "ok") {
  console.error(
    `[watchdog] DEGRADED — down sources: ${health.degraded_sources?.join(", ")}`
  );
  process.exit(1);
}

console.log(`[watchdog] ok — uptime ${health.uptime_seconds}s`);
