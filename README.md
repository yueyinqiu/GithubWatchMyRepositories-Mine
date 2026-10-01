# Watch My Github Repositories!

A GitHub Action that periodically checks which of your repositories (where you have **admin** access) you are **not watching**, and reports them.

> Background: GitHub deprecated automatic watching of repositories in May 2025, so many maintainers stopped receiving notifications for their own repos.
> See [community discussion #157470](https://github.com/orgs/community/discussions/157470).

## What it does

- Lists every repository where you have admin access (personal + org repos)
- Checks the watch subscription of each one
- Files a new issue with the unwatched repos on every run (closing the previous report so you get a notification each time)
- Lets you skip repos via `ignore.txt`

## Usage

### 1. Create a Personal Access Token (classic)

Go to <https://github.com/settings/tokens/new> and create a classic PAT with the following scopes:

- **`repo`** — to list your repositories and read their subscriptions
- **`read:user`** — to read your login name

### 2. Create a repository from this template

Click **Use this template** → **Create a new repository** (top-right of the GitHub repo page).

> **Important: watch your new repository itself**. The report is filed as a new issue here, and you'll only get notified of those issues if you watch the repo.

### 3. Store the token as a secret

In your new repository, go to **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `TOKEN`
- Value: the PAT from step 1

### 4. (Optional) Configure the ignore list

Edit `ignore.txt` in the repo root. One `owner/repo` per line; lines starting with `#` are comments and blank lines are ignored:

```
# Repos I don't need to watch
my-user/archived-project
```

There is also an `ignore-orgs.txt` for silencing warnings about organizations that block your token (see below). One organization login per line, same format as `ignore.txt`.

### 5. Adjust the schedule

The workflow runs on a schedule and can also be triggered manually.

Edit the `schedule.cron` in `.github/workflows/run.yml` to a time of your own.

To trigger manually: **Actions → "Check watched repositories" → Run workflow**.

## Result

After each run:

- If there are unwatched repos, a new issue titled `[auto] Repositories I am not watching` is created in this repo (the previous report issue, if any, is closed first) so you get notified on every run.
- If everything is watched, any open report issue is closed.
- A summary is also written to the run's **Step Summary** for quick review.

### Blocked organizations

Some organizations reject certain tokens entirely (for example, an organization may forbid classic PATs whose lifetime exceeds 366 days, or forbid classic PATs altogether). When that happens their repositories silently disappear from the report.

The script detects this and:

- emits a `::warning::` annotation on the run,
- files a report issue even if there are no unwatched repositories,
- lists the blocked organizations (and GitHub's reason) in the issue body.

To silence a specific organization (for example one you know is permanently incompatible with your token), add its login to `ignore-orgs.txt`.

## How it works

| Purpose | Token used |
| --- | --- |
| List your repos & read subscriptions | `secrets.TOKEN` (your PAT) |
| Create / update / close the report issue | `GITHUB_TOKEN` (provided by the workflow) |

The script is plain Node.js (`script.mjs`), zero dependencies, using native `fetch`, with concurrent checks to keep the run short.

## Notes

- The repository list includes **forks**. To exclude them, list them in `ignore.txt` or filter the `fork` field in the script.
- Organizations that block your token are reported separately; silence them via `ignore-orgs.txt`.
- This project was mainly by AI.