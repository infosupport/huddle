#!/usr/bin/env node
/**
 * aikido-mcp-server.js - Stdio MCP server voor Aikido API.
 *
 * Wordt door de inject-workflow in een devcontainer geplaatst zodat
 * Claude de Aikido API kan aanroepen voor verificatie na een fix.
 *
 * Env vars: AIKIDO_CLIENT_ID, AIKIDO_CLIENT_SECRET
 *
 * Tools:
 *   aikido_issues_list    - Open issues ophalen
 *   aikido_issue_details  - Details van één issue
 *   aikido_scan_repo      - Scan triggeren
 *   aikido_ignore_issue   - Issue negeren
 *   aikido_add_note       - Notitie toevoegen
 *   aikido_list_repos     - Repositories ophalen
 */
"use strict";

const tls = require("tls");
const net = require("net");
const { execFile } = require("child_process");

const API_BASE = "https://app.aikido.dev/api/public/v1";
const TOKEN_URL = "https://app.aikido.dev/api/oauth/token";
const API_KEY     = process.env.AIKIDO_API_KEY     || "";
const CLIENT_ID   = process.env.AIKIDO_CLIENT_ID   || "";
const CLIENT_SECRET = process.env.AIKIDO_CLIENT_SECRET || "";

function log(msg) { process.stderr.write(`[aikido-mcp] ${msg}\n`); }

// Gebruik curl zodat https_proxy automatisch gerespecteerd wordt.
function httpRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const args = ["-s", "-X", method, "--max-time", "30", "-w", "\n__HTTP_STATUS__%{http_code}"];
    for (const [k, v] of Object.entries(headers || {})) {
      if (k.toLowerCase() !== "content-length") args.push("-H", `${k}: ${v}`);
    }
    if (body) args.push("--data-binary", body);
    args.push(url);
    execFile("curl", args, { env: process.env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl: ${err.message}`));
      const split = stdout.lastIndexOf("\n__HTTP_STATUS__");
      const responseBody = split >= 0 ? stdout.slice(0, split) : stdout;
      const status = split >= 0 ? parseInt(stdout.slice(split + 16)) : 0;
      if (status >= 400) reject(new Error(`HTTP ${status}: ${responseBody.slice(0, 500)}`));
      else resolve(responseBody);
    });
  });
}

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (API_KEY) return API_KEY;
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const body = "grant_type=client_credentials";
  const resp = await httpRequest("POST", TOKEN_URL, {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/x-www-form-urlencoded",
  }, body);
  const data = JSON.parse(resp);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  log("OAuth2 token verkregen");
  return cachedToken;
}

async function aikidoRequest(method, path, body) {
  const token = await getToken();
  const url = `${API_BASE}${path}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const bodyStr = body ? JSON.stringify(body) : undefined;
  if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
  return JSON.parse(await httpRequest(method, url, headers, bodyStr));
}

async function fetchIssues(repoName) {
  const issues = [];
  let page = 0;
  while (true) {
    const qs = `?filter_status=open&per_page=50&page=${page}`;
    const data = await aikidoRequest("GET", `/open-issue-groups${qs}`);
    const batch = Array.isArray(data) ? data : (data.groups || []);
    if (!batch.length) break;
    for (const i of batch) {
      if (repoName) {
        const repos = (i.locations || []).map(l => l.code_repo_name || l.name || "");
        if (!repos.some(r => r === repoName)) continue;
      }
      issues.push({ id: String(i.id), title: i.title, severity: i.severity,
        severity_score: i.severity_score, type: i.type,
        affected_package: i.affected_package, cve_ids: i.related_cve_ids || [] });
    }
    if (batch.length < 50) break;
    page++;
  }
  return issues;
}

// ── JSON-RPC 2.0 stdio transport ─────────────────────────────────────────────

const tools = {
  aikido_issues_list: {
    description: "Fetch open Aikido issues, optionally filtered by repository name.",
    inputSchema: {
      type: "object",
      properties: {
        repo_name: { type: "string", description: "Filter by repository name (code_repo_name)" },
      },
    },
    async handler({ repo_name }) {
      const issues = await fetchIssues(repo_name);
      return { content: [{ type: "text", text: issues.length ? JSON.stringify(issues, null, 2) : "No open issues found." }] };
    },
  },

  aikido_issue_details: {
    description: "Fetch details of a single Aikido issue by ID.",
    inputSchema: {
      type: "object",
      properties: { issue_id: { type: "string", description: "The issue ID" } },
      required: ["issue_id"],
    },
    async handler({ issue_id }) {
      const all = await fetchIssues();
      const issue = all.find(i => i.id === String(issue_id));
      return { content: [{ type: "text", text: issue ? JSON.stringify(issue, null, 2) : `Issue ${issue_id} not found.` }] };
    },
  },

  aikido_list_repos: {
    description: "Fetch available code repositories from Aikido.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const data = await aikidoRequest("GET", "/repositories");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  },

  aikido_scan_repo: {
    description: "Trigger a new scan for a repository.",
    inputSchema: {
      type: "object",
      properties: { repo_id: { type: "number", description: "The numeric repository ID" } },
      required: ["repo_id"],
    },
    async handler({ repo_id }) {
      const data = await aikidoRequest("POST", `/repositories/${repo_id}/scans`, {});
      return { content: [{ type: "text", text: `Scan gestart: ${JSON.stringify(data)}` }] };
    },
  },

  aikido_ignore_issue: {
    description: "Ignore an Aikido issue (e.g. false positive or accepted risk).",
    inputSchema: {
      type: "object",
      properties: {
        issue_id: { type: "string" },
        reason: { type: "string", description: "Reason for ignoring" },
      },
      required: ["issue_id", "reason"],
    },
    async handler({ issue_id, reason }) {
      const data = await aikidoRequest("POST", `/open-issue-groups/${issue_id}/ignore`, { reason });
      return { content: [{ type: "text", text: `Issue genegeerd: ${JSON.stringify(data)}` }] };
    },
  },

  aikido_add_note: {
    description: "Add a note to an Aikido issue group.",
    inputSchema: {
      type: "object",
      properties: {
        issue_id: { type: "string" },
        note: { type: "string", description: "The note text" },
      },
      required: ["issue_id", "note"],
    },
    async handler({ issue_id, note }) {
      const data = await aikidoRequest("POST", `/open-issue-groups/${issue_id}/notes`, { note });
      return { content: [{ type: "text", text: `Notitie toegevoegd: ${JSON.stringify(data)}` }] };
    },
  },
};

// ── Stdio JSON-RPC 2.0 server ────────────────────────────────────────────────

let buffer = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    await handleMessage(msg);
  }
});

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "aikido-mcp", version: "1.0.0" },
    }});
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: {
      tools: Object.entries(tools).map(([name, t]) => ({
        name, description: t.description, inputSchema: t.inputSchema,
      })),
    }});
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params;
    const tool = tools[name];
    if (!tool) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Tool not found: ${name}` } });
      return;
    }
    try {
      const result = await tool.handler(args || {});
      send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } });
    }
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

log("Aikido MCP server gestart (stdio)");
