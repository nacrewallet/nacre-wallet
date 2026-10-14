# Publishing this repository

This directory is a standalone wallet repository. It is prepared locally with a clean initial commit and **no GitHub remote**. Creating a GitHub repository or pushing it remains the owner's step.

## First push from Windows

1. Sign in to your GitHub account and create an **empty public repository** named `nacre-wallet`. Do not generate another README, license, or `.gitignore`; they already exist here.
2. Open PowerShell in this directory. Set your real Git author identity **for this repository only**. GitHub provides a no-reply email if you prefer not to publish your personal email.
3. Replace every placeholder in the commands below with your own value, then run them:

```powershell
Set-Location 'C:\Projects\nacre-wallet-open-source'
git config --local user.name 'YOUR NAME'
git config --local user.email 'YOUR GITHUB EMAIL OR NO-REPLY ADDRESS'
git status
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/nacre-wallet.git
git push -u origin main
```

The prepared initial commit uses a neutral project contributor identity. Setting your local name/email affects future commits. If you want your account to be the author of the initial commit, do this **before the first push**, after configuring your identity:

```powershell
git commit --amend --reset-author --no-edit
```

Authenticate through your normal Git credential manager when prompted. Do not put a password or access token in the remote URL, source files, terminal commands, or issue text. If `origin` already exists, inspect `git remote -v` before changing it.

## Repository settings

- Enable private vulnerability reporting so the route described in `SECURITY.md` is available.
- Enable the included CI workflow and review its first result.
- Add a description such as “Self-custodial Pearl (PRL) browser wallet with an opt-in Nacre connector.”
- Keep generated builds, dependency folders, and credentials out of source commits.

## Preparing a release

From a clean checkout of the intended source:

```sh
npm ci
npm run check
npm run package
npm run package:firefox
```

Inspect the resulting extension in a disposable browser profile. Record its commit, version, Node/npm versions, and validation scope. The Chrome and Firefox ZIPs under `releases/` are installable packages; they contain a root-level `manifest.json`.

Commit all source changes before creating a source archive:

```sh
npm run package:source
```

`package:source` requires a clean working tree and archives committed `HEAD`, not uncommitted edits. Its result is `releases/nacre-wallet-source-<version>.zip`; generated artifacts are excluded according to the repository's archive rules. Attach the source archive and appropriate installable ZIPs to a GitHub release if desired. Creating a GitHub release does not publish or sign a browser-store extension.

Use a stable browser extension identity for updates. A separately distributed fork needs its own identity; changing an identity does not migrate existing wallet storage. See [Firefox identity notes](../FIREFOX.md) before publishing a Firefox fork.
