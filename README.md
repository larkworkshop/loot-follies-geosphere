# The Loot Follies Geosphere - setup guide

How it fits together:

```
GitHub (scheduled job)  --reads the chain with your secret Alchemy key-->  data/snapshot.json (committed)
        |
        +--> AWS Amplify notices the commit, rebuilds, and publishes the site
                      |
Visitor's browser  <--+  loads the page + snapshot (no blockchain calls at all)
        |
        +-- clicks a dot --> your Lambda proxy (holds the Alchemy URL) --> Alchemy
                         \--> (if the proxy fails) free public Sepolia endpoints
```

The Alchemy key exists in exactly two places, both private: a GitHub secret and a Lambda setting.
It is never in the repo, the page, or Amplify.

## Files

| File | Purpose |
|---|---|
| `index.html`, `globe-viewer.css` | The viewer |
| `config.json` | The two Sepolia contracts, their names/colours, and the click-lookup endpoints |
| `data/snapshot.json` | Written by the scheduled job. Starts empty. Do not edit by hand |
| `scripts/snapshot.mjs`, `package.json`, `package-lock.json` | The reader the job runs, and the exact package versions it uses |
| `.github/workflows/snapshot.yml` | The schedule (every 15 minutes to start; see "Changing the schedule") |
| `.github/dependabot.yml` | Opens a pull request when a pinned GitHub Action has a new release |
| `amplify.yml` | Tells Amplify which files to publish (nothing to compile) |
| `lambda/index.mjs` | The click-lookup proxy (you paste this into AWS Lambda) |
| `scripts/make-sample-snapshot.mjs` | Local testing only: makes fake tokens (see "Testing on your own computer") |
| `scripts/local-proxy.mjs` | Local testing only: runs the Lambda proxy on your computer |
| `config.local.example.json` | Local testing only: copy to `config.local.json` to point the page at the local proxy |
| `.gitignore` | Keeps `node_modules`, `config.local.json` and the fake sample data out of GitHub |

## Before you go live (about 15 minutes, no code)

These matter more than anything technical in this guide.

1. **Turn on two-factor authentication** for GitHub, AWS, and Alchemy. Someone taking over your GitHub or AWS
   account could change the site your community trusts. This is the most serious realistic risk, and it is free to prevent.
2. **Set an AWS budget alarm.** AWS console > Billing > Budgets > Create budget > a monthly cost budget of, say,
   $10 with an email alert. It emails you; it does not stop spending. Realistic costs here are near zero.
3. **Use a separate Alchemy key for this project**, limited to Sepolia, and make sure your Alchemy plan does not
   bill past its free allowance (check the plan page; I could not see your account). A separate key means a
   flood of traffic here can never use up the quota your mint site depends on.
4. **Limit who can write to the repository.** Anyone with write access can change the workflow to send the secret
   somewhere. Add people only if you trust them.

## Setup

### 1. Two Alchemy keys
In the Alchemy dashboard create **two** Sepolia apps (or two keys): one for GitHub, one for the Lambda proxy.
That way you can see each one's usage and rotate one without breaking the other. Turn on a usage alert for both.
Retire any key that has ever been shown in a screenshot or chat.

The GitHub job needs **only the key** (the long letters-and-numbers string Alchemy shows as "API key"), not the
whole address. The Lambda proxy needs the **whole address** (it looks like
`https://eth-sepolia.g.alchemy.com/v2/<your key>`).

### 2. GitHub
1. Create a repository (public is fine) and upload every file in this folder, keeping the folder layout.
   Do **not** upload `node_modules`. (`.gitignore` already excludes it if you use git.)
2. Repo > Settings > Secrets and variables > Actions > New repository secret. Name it `ALCHEMY_KEY`. The value is
   the API key only (the first key from step 1).
3. Repo > Actions > "Refresh Follies snapshot" > Run workflow. The first run reads every token
   (about 11,600 tokens, roughly 35,000 small calls), so expect a long first run, likely 30-60 minutes. It only
   needs to happen once. Later runs take about a minute: they replay only new mints and transfers.
4. When it finishes, `data/snapshot.json` appears in the repo, committed by `follies-snapshot-bot`.

If a run fails, open it in the Actions tab; the message names the call that failed. Re-running is safe.

How the secret is protected:
- Only the "Read the chain" step receives it. The install step does not.
- The script filters everything it prints, so the key and the address built from it are replaced with
  `[redacted]` even if a library puts them in an error message. I tested this: ethers does put the full address
  in some error messages, and the filter removed it.
- Packages are installed from `package-lock.json` with `npm ci --ignore-scripts`, and the GitHub Actions are pinned
  to exact versions, so nothing changes under you. Dependabot will propose updates for you to review.
- Do not turn on debug logging for this workflow and do not add steps that print environment variables.

GitHub pauses scheduled jobs in public repos after about 60 days without repo activity. If the job ever
stops, Actions > enable workflow.

### 3. AWS Amplify (the website)
1. AWS console > AWS Amplify > Create new app > GitHub > authorize > pick your repo and the `main` branch.
2. Amplify finds `amplify.yml` in the repo and uses it. Save and deploy.
3. You get an address like `https://main.d1abc2defg.amplifyapp.com`. That is your site. (A custom domain can be
   added later under Hosting > Custom domains.)
4. **Test that bot commits trigger a rebuild.** After the first snapshot commit from step 2 above, check
   Amplify > your app > the `main` branch for a build that started by itself.
   - If it did: nothing more to do.
   - If it did not (I could not confirm this from the docs): in Amplify > App settings > Build settings >
     Incoming webhooks, create a webhook for `main`, copy its URL, and add it as a GitHub repository secret named
     `AMPLIFY_WEBHOOK_URL`. The workflow then asks Amplify to rebuild after every changed snapshot.

Leave GitHub Pages switched off. Amplify is the only thing that publishes the site.

### 4. Lambda proxy (keeps the click lookups secret)

**What it is.** When a visitor clicks a dot, the page needs that token's artwork from the blockchain, and that
means asking an RPC provider such as Alchemy. Anything a web page knows, a visitor can read, so the page
cannot hold your Alchemy key. The proxy solves that. It is a small program running on AWS at its own web
address. The page asks the proxy, and the proxy asks Alchemy using the key stored in its private settings. The
visitor only ever sees the proxy's address. Think of it as a receptionist who holds the key and will fetch
exactly two things, nothing else.

**You can do this step last.** The site works without it: any entry in `config.json` that still contains `YOUR-`
is skipped, and clicks fall back to the free public endpoints. Set the proxy up before you announce the site so
the key stays private. Do Amplify (step 3) first, because the proxy needs your site's address. You can also try
the proxy on your own computer first (see "Testing on your own computer").

**Set it up.**

1. In the AWS console, search for **Lambda** and click **Create function**. Choose **Author from scratch**, name
   it `follies-rpc-proxy`, pick the newest **Node.js** runtime (22.x or later), and click **Create function**.
2. The **Code** tab shows an editor with a file called `index.mjs`. Delete everything in it, paste in the
   contents of `lambda/index.mjs` from this project, and click **Deploy**.
3. Open the **Configuration** tab, then **General configuration**, then **Edit**. Set **Timeout** to
   **20 seconds** and save. The default of 3 seconds is too short and is the most common cause of failures.
4. Still under **Configuration**, open **Environment variables** and click **Edit**. Add three settings. This is
   where the secret lives. It is not in your code, your repo, or your site.

   | Key | Value |
   |---|---|
   | `ALCHEMY_URL` | The **full** Alchemy Sepolia address from your second (separate) key |
   | `CONTRACTS` | `0x91977DC9D1d6B57FE97C3D2dAF9db3b1D5381597,0x5B79b23832A551f76F132d4ed30A690b6d877180` |
   | `ALLOWED_ORIGINS` | Your site address from step 3, for example `https://main.d1abc2defg.amplifyapp.com` (comma-separate more than one, such as a custom domain) |

5. Under **Configuration**, open **Function URL** and click **Create function URL**. Set **Auth type** to
   **NONE** and save. NONE sounds alarming, but it only means anyone can call the address. A browser cannot
   sign AWS requests, so it has to be open. The protection is in the code: it answers only `tokenURI` and
   `ownerOf` on your two contracts, for the latest block, and refuses everything else. Leave **CORS** off,
   because the code handles it. AWS shows you a web address ending in `.lambda-url.<region>.on.aws`. Copy it.
6. Under **Configuration**, open **Concurrency** and reserve about **5**. This caps how much work anyone can
   ever make the function do. New AWS accounts sometimes refuse a reservation. If so, skip it and rely on the
   Alchemy usage alert and your AWS budget alarm.
7. Put the Function URL into `config.json` in place of the placeholder (see step 5 below), then commit.
   Amplify redeploys.

**Test it before relying on it.** In a terminal, with your own function address and site address filled in:

```
curl -X POST "YOUR_FUNCTION_URL" -H "content-type: application/json" -H "Origin: https://YOUR_SITE_ADDRESS" -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

A working proxy replies `{"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}`. That is Sepolia's chain number. Then
click a dot on your live site and open the function's **Monitor** tab in Lambda. You should see a request come in.

**If something goes wrong.**

| What you see | Likely cause |
|---|---|
| `origin not allowed` | The `Origin` you sent (or your site's address) does not exactly match `ALLOWED_ORIGINS`. Check for a typo, `http` vs `https`, or a trailing path. Calls without any `Origin` are refused on purpose. |
| The request hangs, then `Task timed out` | The timeout is still 3 seconds. Redo step 3. |
| `proxy is not configured` | `ALCHEMY_URL` or `CONTRACTS` is missing. Check step 4. |
| `contract not allowed` | The address in the call is not in `CONTRACTS`, or has a typo. |
| `upstream error 401` or `403` | The Alchemy address in `ALCHEMY_URL` is wrong, or that key is restricted. |
| `slow down` (429) | One visitor made more than 60 calls in a minute. Raise `RATE_PER_MINUTE` only if you need to. |
| The page shows "Could not load the artwork" but the proxy works | Check the browser console for a CORS message. It means `ALLOWED_ORIGINS` does not match the address in the browser. |

**What the proxy will and will not do.** It answers only `tokenURI` and `ownerOf` for the contracts in
`CONTRACTS`. Anyone who finds its address can ask for those two public facts. They cannot read your Alchemy
URL or run any other call. It also limits each visitor to 60 calls a minute, and the concurrency cap in step 6
limits the total.

### 5. Point the site at the proxy
In `config.json`, replace the placeholder in `rpcUrls` with your Function URL, commit, and Amplify redeploys:

```json
"rpcUrls": [
  "https://abc123xyz.lambda-url.us-east-1.on.aws/",
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org"
]
```

The page tries them in order, giving each 12 seconds. The two public endpoints after the proxy are the backup;
I could not test them from my build environment, so confirm one works for you (or swap in another public
Sepolia endpoint). Entries that still contain `YOUR-` are skipped automatically.

### 6. Check it
- Site loads, both collections appear in the Collections box, "Snapshot updated ... ago" shows under it.
- Untick a contract: its dots disappear and the counts change. Tick it again to bring it back.
- Click a dot: the artwork loads. Reopen the same one: instant (cached in the browser for 30 minutes).
- In the Lambda console > Monitor, you should see invocations when you click dots.

## Testing on your own computer (no GitHub, no AWS)

One-time: install Node.js (version 20 or newer), open a terminal in the project folder, and run `npm install`.
Serve the folder with a local web server, for example VS Code's **Live Server** (right-click `index.html` >
Open with Live Server). The page address will look like `http://127.0.0.1:5500/index.html`.

Opening `index.html` straight from the file explorer, or adding `?dev`, gives the old Network card instead.

**A. Fake data (fastest; no blockchain, no key).** Tests the globe, the contract checkboxes, and the wallet, Order,
and Use filters, at the real size.
1. Run `npm run sample`. It writes `data/snapshot.sample.json` with 5,788 invented tokens for each contract.
   (For a different number: `node scripts/make-sample-snapshot.mjs 2000`.)
2. Open `http://127.0.0.1:5500/index.html?snapshot=data/snapshot.sample.json`. A yellow "TEST DATA" note shows
   under the Collections box. Clicking a dot shows no artwork, by design, because the tokens are invented.

The sample file is excluded from GitHub and from the Amplify build, so it cannot go live by accident. The
`?snapshot=` option only accepts a file inside the site's own `data` folder.

**B. Real data, locally.** Runs the same job GitHub would run.
- Mac or Linux: `ALCHEMY_KEY="your-key" npm run snapshot`
- Windows PowerShell: `$env:ALCHEMY_KEY="your-key"; npm run snapshot`

It writes `data/snapshot.json` (the first run reads every token, so allow it time). Then open the page normally.
The snapshot file contains no key.

**C. The proxy, locally.** Tries the click lookups the way the live site will, before touching AWS.
1. In one terminal: `ALCHEMY_KEY="your-key" npm run local-proxy` (PowerShell: `$env:ALCHEMY_KEY="your-key"; npm run local-proxy`).
   Leave it running. It shows one line for every request.
2. Copy `config.local.example.json` to `config.local.json`. It points the page at the proxy on your computer.
3. Open the page through Live Server and click a dot. You should see lines appear in the proxy window.

`config.local.json` is used only when the page is opened from your own computer. A real website never asks for
it, and `.gitignore` keeps it out of GitHub. It replaces `config.json` completely while you test, so it contains
all the same fields. If your Live Server is not on port 5500, add `ALLOWED_ORIGINS="http://127.0.0.1:YOURPORT"`
when you start the proxy.

**What only works on the live setup:** the schedule and the GitHub secret, Amplify rebuilding after a commit, the
real Lambda address, and the origin check against your real site address.

## Day to day

- **Changing the schedule.** It starts at every 15 minutes. After the first week or so, open
  `.github/workflows/snapshot.yml`, find the line `- cron: "*/15 * * * *"`, and replace it with
  `- cron: "17 * * * *"` for hourly. Commit the change. (GitHub does not allow a schedule to be a setting, so
  this one line is the switch. Anything shorter than every 5 minutes is not allowed.)
- A new mint or transfer shows up after the next run plus the Amplify build: about 15 minutes plus a few at the
  start, about an hour plus a few later.
- To add or change a contract, edit `config.json` and commit. The job re-reads the chain automatically.
- If token traits ever change after mint, run the workflow manually with "Rescan every token" ticked.
- When Dependabot opens a pull request for a GitHub Action, read the release notes and merge it.

## Costs (approximate; check current AWS pricing)
- GitHub Actions and the repo: free for a public repo.
- Amplify: build minutes are free up to 1,000 a month, then $0.01 a minute; hosting includes 15 GB of
  traffic a month, then $0.15 per GB. Builds only happen when the snapshot changes (plus about one a day). On the
  15-minute schedule during a busy mint week that could be up to about 100 builds a day at 1-2 minutes each. A
  full week of that is roughly the free allowance, and the worst case beyond it is a few dollars.
- Lambda: well inside the free allowance at this scale.
- Alchemy: the first scan is roughly 1 million compute units; each run after that is tiny.

## Later, around mainnet
Self-host the ethers script instead of loading it from a public CDN, add a Content-Security-Policy header in
Amplify, and add a warning on the page when the snapshot is more than a few hours old. For mainnet, change
`chainId` and the contract addresses in `config.json`, and use a mainnet key for the job and the proxy.
