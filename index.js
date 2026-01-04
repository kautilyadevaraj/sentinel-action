// index.js - complete GitHub Action entrypoint
const core = require("@actions/core");
const github = require("@actions/github");

async function httpPostJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  // Try parse JSON; if not JSON, return raw text
  try {
    return JSON.parse(txt);
  } catch (e) {
    return txt;
  }
}

function extractAssistantTextFromAdkResponse(res) {
  // ADK often returns an array of events. We want the last event that has content.parts[0].text
  if (!res) return null;
  if (Array.isArray(res)) {
    let lastText = null;
    for (const ev of res) {
      if (
        ev &&
        ev.content &&
        Array.isArray(ev.content.parts) &&
        ev.content.parts.length > 0
      ) {
        const p = ev.content.parts[0];
        if (p && typeof p.text === "string" && p.text.trim().length > 0) {
          lastText = p.text;
        }
      }
    }
    return lastText;
  }
  // If response shape is { events: [...] } or { result: ... }, handle basic variants
  if (res.events && Array.isArray(res.events)) {
    for (const ev of res.events.reverse()) {
      if (
        ev &&
        ev.content &&
        Array.isArray(ev.content.parts) &&
        ev.content.parts[0] &&
        ev.content.parts[0].text
      ) {
        return ev.content.parts[0].text;
      }
    }
  }
  // If ADK returns a single object with content
  if (
    res.content &&
    Array.isArray(res.content.parts) &&
    res.content.parts[0] &&
    res.content.parts[0].text
  ) {
    return res.content.parts[0].text;
  }
  // fallback to stringifying the whole body
  try {
    return JSON.stringify(res, null, 2);
  } catch (e) {
    return String(res);
  }
}

async function run() {
  try {
    const AGENT_URL = "http://139.84.130.76:8000";
    const agentUrl = AGENT_URL;
    if (!agentUrl) throw new Error("agent_url input or AGENT_URL env required");

    const appName = "adk_agent";
    const agentAuthToken =
      process.env.AGENT_AUTH_TOKEN || core.getInput("agent_auth_token") || "";

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) throw new Error("GITHUB_TOKEN not set in environment");

    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    const pr = context.payload.pull_request;
    if (!pr) {
      core.setFailed(
        "No pull_request found in the GitHub Action context. Trigger this on pull_request events."
      );
      return;
    }

    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const prNumber = pr.number;

    // List files changed in the PR
    core.info(`Fetching files for PR #${prNumber}`);
    const filesResp = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const files = filesResp.data || [];

    // Build a textual diff-like payload (ADK expects text in `parts[].text`)
    let diffText = `Repository: ${owner}/${repo}\nPR: #${prNumber} - ${
      pr.title || ""
    }\n\n`;
    diffText += `Description:\n${pr.body || "(no PR body)"}\n\n---FILES---\n`;
    for (const f of files) {
      diffText += `\nFile: ${f.filename}\nAdditions: ${
        f.additions
      }\nDeletions: ${f.deletions}\n\nPatch:\n${
        f.patch || "(no patch available)"
      }\n\n----------------------------------------\n`;
    }

    // Session identifiers
    const userId = "github-action";
    const sessionId = `pr-${prNumber}`;

    // Create session
    core.info("Creating session on ADK server");
    const sessionUrl = `${agentUrl.replace(
      /\/$/,
      ""
    )}/apps/${appName}/users/${encodeURIComponent(
      userId
    )}/sessions/${encodeURIComponent(sessionId)}`;
    const sessionHeaders = agentAuthToken
      ? { "x-agent-auth": agentAuthToken }
      : {};
    await httpPostJson(sessionUrl, {}, sessionHeaders);

    // Call /run endpoint
    core.info("Calling /run on ADK server");
    const runUrl = `${agentUrl.replace(/\/$/, "")}/run`;
    const runPayload = {
      appName,
      userId,
      sessionId,
      newMessage: {
        role: "user",
        parts: [
          {
            text: `${diffText}`,
          },
        ],
      },
    };

    const runResp = await httpPostJson(runUrl, runPayload, sessionHeaders);

    const assistantText = extractAssistantTextFromAdkResponse(runResp);
    if (!assistantText) {
      core.setFailed(
        "No assistant text found in ADK response. Response: " +
          JSON.stringify(runResp).slice(0, 1000)
      );
      return;
    }

    core.info("Posting comment on PR");
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: assistantText,
    });

    core.info("Posted AI review comment successfully.");
  } catch (error) {
    core.setFailed(error.message || String(error));
  }
}

run();
