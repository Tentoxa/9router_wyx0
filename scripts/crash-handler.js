/**
 * Production server wrapper — adds crash handlers BEFORE Next.js starts.
 *
 * In Docker, this replaces `node server.js` as the CMD.
 * It sets up forensic crash capture so that when the zombie bug strikes,
 * we get the FULL stack trace + process state in a dump file.
 *
 * This file is copied to .next/standalone/ at build time and runs in the
 * container as: node crash-handler.js
 */

const { writeFileSync, mkdirSync, existsSync, appendFileSync } = require("node:fs");
const path = require("node:path");

const CRASH_DIR = process.env.CRASH_DIR || "/app/data/crashes";
const FATAL_ERROR_WINDOW_MS = 10_000;
let fatalCount = 0;
let firstFatalAt = 0;

function ensureCrashDir() {
  try {
    if (!existsSync(CRASH_DIR)) mkdirSync(CRASH_DIR, { recursive: true });
  } catch (e) {
    console.error("[crash-handler] Failed to create crash dir:", e.message);
  }
}

ensureCrashDir();

function captureFullStack(err) {
  const lines = [];
  lines.push(`Error: ${err?.message || String(err)}`);
  lines.push(`  code: ${err?.code || err?.cause?.code || "?"}`);
  lines.push(`  errno: ${err?.errno || "?"}`);
  lines.push(`  syscall: ${err?.syscall || "?"}`);
  lines.push(`  name: ${err?.name || "?"}`);

  if (err?.stack) {
    lines.push("");
    lines.push("=== FULL STACK TRACE ===");
    lines.push(err.stack);
  }

  let depth = 0;
  let cause = err?.cause;
  while (cause && depth < 10) {
    depth++;
    lines.push("");
    lines.push(`=== cause[${depth}] ===`);
    lines.push(`  message: ${cause.message || String(cause)}`);
    lines.push(`  code: ${cause.code || "?"}`);
    if (cause.stack) lines.push(cause.stack);
    cause = cause.cause;
  }

  return lines.join("\n");
}

function captureProcessState() {
  const lines = [];
  lines.push("=== PROCESS STATE AT CRASH ===");
  lines.push(`  timestamp: ${new Date().toISOString()}`);
  lines.push(`  uptime: ${Math.round(process.uptime())}s`);
  lines.push(`  pid: ${process.pid}`);
  lines.push(`  node: ${process.version}`);
  lines.push(`  platform: ${process.platform} ${process.arch}`);

  const mem = process.memoryUsage();
  lines.push("");
  lines.push("=== MEMORY ===");
  lines.push(`  rss:          ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
  lines.push(`  heapUsed:     ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
  lines.push(`  heapTotal:    ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`);
  lines.push(`  external:     ${(mem.external / 1024 / 1024).toFixed(1)} MB`);
  lines.push(`  arrayBuffers: ${(mem.arrayBuffers / 1024 / 1024).toFixed(1)} MB`);

  lines.push("");
  lines.push("=== ACTIVE HANDLES (sockets, timers, etc.) ===");
  try {
    const handles = process._getActiveHandles();
    lines.push(`  total: ${handles.length}`);

    const byType = {};
    for (const h of handles) {
      const ctor = h?.constructor?.name || "unknown";
      byType[ctor] = (byType[ctor] || 0) + 1;
    }
    for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${type}: ${count}`);
    }

    const sockets = handles.filter(h => h?.constructor?.name === "Socket" || h?.constructor?.name === "TLSSocket");
    if (sockets.length > 0) {
      lines.push("");
      lines.push(`  === SOCKET DETAILS (${sockets.length} sockets) ===`);
      for (let i = 0; i < Math.min(sockets.length, 50); i++) {
        const s = sockets[i];
        lines.push(`    [${i}] ${JSON.stringify({
          destroyed: s.destroyed,
          readable: s.readable,
          writable: s.writable,
          remoteAddress: s.remoteAddress,
          remotePort: s.remotePort,
          localPort: s.localPort,
          bytesWritten: s.bytesWritten,
          bytesRead: s.bytesRead,
          timeout: s.timeout,
        })}`);
      }
      if (sockets.length > 50) lines.push(`    ... and ${sockets.length - 50} more`);
    }
  } catch (e) {
    lines.push(`  (failed to get active handles: ${e.message})`);
  }

  lines.push("");
  lines.push("=== ACTIVE REQUESTS ===");
  try {
    const requests = process._getActiveRequests();
    lines.push(`  total: ${requests.length}`);
  } catch (e) {
    lines.push(`  (failed: ${e.message})`);
  }

  return lines.join("\n");
}

function writeCrashDump(source, err, isTransient) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `crash-${ts}-${process.pid}.log`;
  const filepath = path.join(CRASH_DIR, filename);

  const sections = [
    `══════════════════════════════════════════════════════════════════════════════`,
    `  WYXROUTER CRASH DUMP`,
    `  Source: ${source}`,
    `  Transient: ${isTransient} (true = swallowed, false = process will exit)`,
    `  Fatal count in 10s window: ${fatalCount}`,
    `══════════════════════════════════════════════════════════════════════════════`,
    ``,
    captureFullStack(err),
    ``,
    captureProcessState(),
    ``,
    `══════════════════════════════════════════════════════════════════════════════`,
    `  END OF DUMP`,
    `══════════════════════════════════════════════════════════════════════════════`,
  ];

  try {
    writeFileSync(filepath, sections.join("\n"), "utf8");
    console.error(`[FATAL] Crash dump written to: ${filepath}`);
  } catch (e) {
    console.error(`[FATAL] Failed to write crash dump: ${e.message}`);
    console.error(sections.join("\n"));
  }

  try {
    const rollingLog = path.join(CRASH_DIR, "crash-history.log");
    appendFileSync(rollingLog,
      `[${ts}] source=${source} transient=${isTransient} count=${fatalCount} code=${err?.code || err?.cause?.code || "?"} msg=${(err?.message || String(err)).slice(0, 200)} file=${filename}\n`,
      "utf8"
    );
  } catch { /* best-effort */ }

  return filepath;
}

function handleFatalError(source, err) {
  const now = Date.now();
  if (now - firstFatalAt > FATAL_ERROR_WINDOW_MS) {
    fatalCount = 0;
    firstFatalAt = now;
  }
  fatalCount++;

  const code = err?.code || err?.cause?.code || "?";
  const msg = err?.message || String(err);

  const isIdleSocketReset =
    code === "ECONNRESET" ||
    code === "UND_ERR_SOCKET" ||
    code === "EPIPE" ||
    msg.includes("aborted") ||
    msg.includes("socket hang up");

  const dumpPath = writeCrashDump(source, err, isIdleSocketReset && fatalCount < 3);

  console.error(`[FATAL:${source}] code=${code} | msg=${msg} | dump=${dumpPath}`);

  if (isIdleSocketReset && fatalCount < 3) {
    console.warn(`[FATAL:${source}] idle socket reset swallowed (count=${fatalCount} in 10s window)`);
    return;
  }

  console.error(`[FATAL:${source}] exiting process (count=${fatalCount} in 10s window)`);
  process.exit(1);
}

// Register handlers BEFORE requiring server.js
process.on("uncaughtException", (err) => handleFatalError("uncaughtException", err));
process.on("unhandledRejection", (err) => handleFatalError("unhandledRejection", err));

console.log("[crash-handler] Forensic crash capture enabled. Dumps →", CRASH_DIR);

// Now start the actual Next.js server
require("./server.js");
