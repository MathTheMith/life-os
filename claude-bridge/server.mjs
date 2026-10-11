// Runs on the HOST (not in a container) because it needs the `claude` CLI
// already authenticated here, under the same account as any interactive
// session — that's the whole point: same billing/quota as normal usage,
// no separate API key. The backend container reaches this over
// host.docker.internal since it can't see host processes directly.
//
// Listens on all interfaces because the backend container reaches it via
// the docker network's gateway IP (not loopback — host.docker.internal
// resolves to that gateway, which binding to 127.0.0.1 would refuse).
// Nothing is exposed to the real internet by that alone (no firewall rule
// routes the public IP to this port), but isAllowedSource() below is a
// second, explicit line: only loopback or docker-internal addresses may
// call this, so the one caller that matters (the backend container) is
// the only one that can.
function isAllowedSource(ip) {
  const v4 = ip.replace(/^::ffff:/, "");
  return v4 === "127.0.0.1" || ip === "::1" || /^172\.(1[6-9]|2\d|3[01])\./.test(v4) || /^192\.168\./.test(v4);
}
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const PORT = 4200;
const WORKDIR = "/root/life-os";
// systemd's own PATH doesn't include this (it's a per-user install), so
// spawn() can't find "claude" by name alone under the service.
const CLAUDE_BIN = "/root/.local/bin/claude";
const SESSION_FILE = "/root/life-os/claude-bridge/session.json";
// Hard caps so a chat message can never trigger an open-ended bill or hang
// the HTTP request forever: generous enough for a few tool rounds of real
// research, nowhere near what a careless prompt could otherwise run up.
const MAX_BUDGET_USD = "0.50";
const TIMEOUT_MS = 150_000;
// Read-only + search only, on purpose: this is for code questions and
// research, not for letting a casual chat message edit files or run shell
// commands on the server. No WebFetch: the chat context carries mails and
// web pages, and a prompt injected there could otherwise read a secret and
// send it out in a URL. The secrets themselves are also off limits to Read.
const ALLOWED_TOOLS = "Read,Grep,Glob,WebSearch";
const DENIED_TOOLS = ["Read(./.env)", "Read(./.env.*)", "Read(./secrets/**)", "Read(./claude-bridge/session.json)"];

function loadSessionId() {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")).sessionId;
  } catch {
    return null;
  }
}

function saveSessionId(id) {
  writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id }));
}

function askClaude(message) {
  return new Promise((resolve, reject) => {
    const existing = loadSessionId();
    const args = [
      "-p",
      message,
      "--output-format",
      "json",
      "--restricted",
      "--tools",
      ALLOWED_TOOLS,
      "--permission-prompts",
      "none",
      "--model",
      "sonnet",
      "--max-budget-usd",
      MAX_BUDGET_USD,
      "--disallowed-tools",
      ...DENIED_TOOLS,
    ];
    if (existing) args.push("--resume", existing);
    else args.push("--session-id", randomUUID());

    const child = spawn(CLAUDE_BIN, args, { cwd: WORKDIR });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Claude n'a pas répondu à temps (timeout)."));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout);
        if (data.session_id) saveSessionId(data.session_id);
        if (data.is_error) return reject(new Error(data.result || "Erreur Claude Code."));
        resolve({ reply: data.result || "(réponse vide)", costUsd: data.total_cost_usd ?? null });
      } catch {
        reject(new Error(stderr.trim() || "Sortie illisible de Claude Code."));
      }
    });
  });
}

// One-shot completion for the backend's background jobs and chat turns: a
// fresh session every call (never the chat's resumed one, so job prompts
// don't leak into the conversation), no tools except Read for an image.
const COMPLETE_MAX_PARALLEL = 2;
const IMAGE_DIR = "/root/life-os/claude-bridge/tmp";
mkdirSync(IMAGE_DIR, { recursive: true });

let running = 0;
const queued = [];
function withSlot(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      running++;
      task()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queued.shift()?.();
        });
    };
    if (running < COMPLETE_MAX_PARALLEL) start();
    else queued.push(start);
  });
}

function askOnce(prompt, imagePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--tools",
      imagePath ? "Read" : "",
      "--permission-prompts",
      "none",
      "--model",
      "sonnet",
    ];
    if (imagePath) args.push("--add-dir", IMAGE_DIR);
    const child = spawn(CLAUDE_BIN, args, { cwd: WORKDIR });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Claude n'a pas répondu à temps (timeout)."));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout);
        if (data.is_error) return reject(new Error(data.result || "Erreur Claude Code."));
        resolve(data.result || "");
      } catch {
        reject(new Error(stderr.trim() || "Sortie illisible de Claude Code."));
      }
    });

    const fullPrompt = imagePath
      ? `${prompt}\n\nL'image à analyser est dans le fichier ${imagePath} : lis-le avec l'outil Read avant de répondre.`
      : prompt;
    child.stdin.end(fullPrompt);
  });
}

const IMAGE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

async function complete(prompt, image) {
  let imagePath = null;
  if (image) {
    const match = /^data:(image\/[a-z+]+);base64,(.+)$/is.exec(image);
    if (!match) throw new Error("Image invalide.");
    const ext = IMAGE_EXT[match[1].toLowerCase()] ?? "jpg";
    imagePath = path.join(IMAGE_DIR, `${randomUUID()}.${ext}`);
    writeFileSync(imagePath, Buffer.from(match[2], "base64"));
  }
  try {
    return await withSlot(() => askOnce(prompt, imagePath));
  } finally {
    if (imagePath) unlinkSync(imagePath);
  }
}

const server = createServer((req, res) => {
  if (!isAllowedSource(req.socket.remoteAddress || "")) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === "POST" && req.url === "/complete") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { prompt, image } = JSON.parse(body);
        if (!prompt || typeof prompt !== "string") throw new Error("prompt requis");
        const content = await complete(prompt, typeof image === "string" ? image : null);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ content }));
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  if (req.method !== "POST" || req.url !== "/ask") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const { message } = JSON.parse(body);
      if (!message || typeof message !== "string") throw new Error("message requis");
      const result = await askClaude(message);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
    }
  });
});

// Bound to the docker-compose network's gateway IP specifically (not
// 0.0.0.0) — that's how host.docker.internal resolves from inside the
// backend container, and it's only reachable from inside that docker
// network, never from the VPS's public interface.
const BIND_HOST = process.env.CLAUDE_BRIDGE_BIND || "172.28.1.1";
server.listen(PORT, BIND_HOST, () => console.log(`claude-bridge listening on ${BIND_HOST}:${PORT}`));
