#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

/**
 * @typedef {Object} Subscription
 * @property {boolean} subscribed
 * @property {boolean} ignored
 * @property {string | null} reason
 */

/**
 * @typedef {Object} Issue
 * @property {number} number
 * @property {string} title
 * @property {string | null} body
 */

const TOKEN = process.env.TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const ISSUE_TITLE = "[auto] Repositories I am not watching";
const IGNORE_FILE = "ignore.txt";
const IGNORE_ORGS_FILE = "ignore-orgs.txt";

if (!TOKEN) {
  console.error("::error::TOKEN is missing.");
  process.exit(1);
}
if (!GITHUB_TOKEN) {
  console.error("::error::GITHUB_TOKEN is missing.");
  process.exit(1);
}
if (!REPO) {
  console.error("::error::GITHUB_REPOSITORY is missing.");
  process.exit(1);
}

/**
 * @param {string} path
 * @param {RequestInit} [opts]
 * @param {string} [token]
 * @returns {Promise<Response>}
 */
async function api(path, opts = {}, token = TOKEN) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...opts.headers,
    },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  return res;
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<unknown>} fn
 * @returns {Promise<unknown[]>}
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

async function main() {
  console.log("::group::Setup");
  const login = (await (await api("/user")).json()).login;
  console.log(`Authenticated as ${login}`);
  console.log(`Report issue will be filed in ${REPO}`);
  console.log("::endgroup::");

  console.log("::group::Listing repositories");
  /** @type {string[]} */
  const repos = [];
  for (let page = 1; ; page++) {
    const res = await api(
      `/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`
    );
    const data = await res.json();
    const admins = data.filter((r) => r.permissions?.admin);
    repos.push(...admins.map((r) => r.full_name));
    console.log(`Page ${page}: ${data.length} repos, ${admins.length} with admin`);
    if (data.length < 100) break;
  }
  console.log(`Total admin repos: ${repos.length}`);
  console.log("::endgroup::");

  console.log("::group::Checking for blocked organizations");
  /** @type {Set<string>} */
  let ignoredOrgs;
  try {
    ignoredOrgs = new Set(
      readFileSync(IGNORE_ORGS_FILE, "utf8")
        .split("\n")
        .map((l) => l.replace(/\s*#.*$/, "").trim())
        .filter(Boolean)
    );
  } catch {
    ignoredOrgs = new Set();
  }

  /** @type {{ login: string; message: string }[]} */
  const blockedOrgs = [];
  try {
    const orgs = await (await api("/user/orgs?per_page=100")).json();
    const repoOwners = new Set(repos.map((r) => r.split("/")[0]));
    for (const org of orgs) {
      if (repoOwners.has(org.login) || ignoredOrgs.has(org.login)) continue;
      const res = await fetch(`https://api.github.com/orgs/${org.login}/memberships/${login}`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (res.status === 403) {
        let message = "";
        try {
          message = (await res.json()).message || "";
        } catch {}
        console.log(
          `::warning::Organization '${org.login}' is blocking this token, so its repositories are missing from this report. ${message}`
        );
        blockedOrgs.push({ login: org.login, message });
      }
    }
  } catch (err) {
    console.log(`  (could not check organizations: ${err.message})`);
  }
  console.log(
    blockedOrgs.length
      ? `Blocked organizations: ${blockedOrgs.map((o) => o.login).join(", ")}`
      : "No blocked organizations detected."
  );
  console.log("::endgroup::");

  /** @type {Set<string>} */
  let ignored;
  try {
    ignored = new Set(
      readFileSync(IGNORE_FILE, "utf8")
        .split("\n")
        .map((l) => l.replace(/\s*#.*$/, "").trim())
        .filter(Boolean)
    );
  } catch {
    ignored = new Set();
  }
  console.log(`Ignored (${ignored.size}): ${[...ignored].join(", ") || "<none>"}`);

  const targets = repos.filter((r) => !ignored.has(r));
  for (const r of repos) if (ignored.has(r)) console.log(`  skip (ignored): ${r}`);

  console.log("::group::Checking subscriptions");
  /**
   * @typedef {Object} UnwatchedRepo
   * @property {string} fullName
   * @property {string} reason
   */

  /**
   * @param {string} fullName
   * @returns {Promise<UnwatchedRepo | null>} null if watched
   */
  async function check(fullName) {
    const res = await api(`/repos/${fullName}/subscription`);
    if (res.status === 404) {
      console.log(`  not watching: ${fullName} (never subscribed)`);
      return { fullName, reason: "never subscribed" };
    }
    /** @type {Subscription} */
    const s = await res.json();
    if (s.subscribed) {
      console.log(`  watching:     ${fullName}`);
      return null;
    }
    const reason = s.reason || "unsubscribed";
    console.log(`  not watching: ${fullName} (${reason})`);
    return { fullName, reason };
  }

  /** @type {UnwatchedRepo[]} */
  const unwatched = (await mapLimit(targets, 10, check)).filter(Boolean);
  console.log(`Checking done. Unwatched: ${unwatched.length} / ${targets.length}`);
  console.log("::endgroup::");

  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [
    `Automatically generated report of repositories where **${login}** has admin access but is not watching.`,
    "",
    `> Last checked: ${now}`,
    "",
  ];
  if (unwatched.length) {
    lines.push(`## Not watching (${unwatched.length} of ${repos.length})`, "");
    unwatched.forEach((r) => lines.push(`- [${r.fullName}](https://github.com/${r.fullName}) — ${r.reason}`));
  } else if (blockedOrgs.length) {
    lines.push("All visible repositories are watched.", "");
  }
  if (blockedOrgs.length) {
    lines.push(
      "",
      `## ⚠️ Blocked organizations (${blockedOrgs.length})`,
      "",
      "These organizations rejected this token, so their repositories are **missing** from this report. Fix the token or the organization's access policy, then re-run.",
      ""
    );
    blockedOrgs.forEach((o) => lines.push(`- \`${o.login}\` — ${o.message}`));
  }
  const body = lines.join("\n");

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `# Watch status\nAdmin: ${repos.length}\nNot watching: ${unwatched.length}${blockedOrgs.length ? `\nBlocked organizations: ${blockedOrgs.map((o) => o.login).join(", ")}` : ""}\n\n${unwatched.map((r) => `- [${r.fullName}](https://github.com/${r.fullName}) — ${r.reason}`).join("\n") || "All watched."}\n`
    );
  }

  console.log("::group::Report");
  /** @type {Issue[]} */
  const issues = await (await api(`/repos/${REPO}/issues?state=open&per_page=100`, {}, GITHUB_TOKEN)).json();
  const existing = issues.find((i) => i.title === ISSUE_TITLE)?.number;

  if (!unwatched.length && !blockedOrgs.length) {
    if (existing) {
      await api(`/repos/${REPO}/issues/${existing}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }, GITHUB_TOKEN);
      console.log(`Closed issue #${existing}.`);
    } else {
      console.log("No unwatched repos, no blocked organizations, and no open report issue. Nothing to do.");
    }
    console.log("::endgroup::");
    return;
  }

  if (existing) {
    await api(`/repos/${REPO}/issues/${existing}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }, GITHUB_TOKEN);
    console.log(`Closed superseded issue #${existing}.`);
  }
  const res = await api(`/repos/${REPO}/issues`, { method: "POST", body: JSON.stringify({ title: ISSUE_TITLE, body }) }, GITHUB_TOKEN);
  console.log(`Created issue #${(await res.json()).number}.`);
  console.log("::endgroup::");
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
