# pi-controls recipes

Each recipe states the intent, the config, and how a few real calls resolve. Merge only the pieces you need into the user's existing file.

## 1. Permissive, but ask before risky bash

"Let it do anything in my projects, but ask before pushes, deletes, and installs."

```jsonc
{
  "policies": {
    "dev": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask",  "tool": "bash", "pattern": "git push*" },
        { "action": "ask",  "tool": "bash", "pattern": "rm *" },
        { "action": "ask",  "tool": "bash", "pattern": "npm publish*" },
        { "action": "deny", "tool": "bash", "pattern": "git push --force*" }
      ]
    }
  },
  "defaultPolicy": "dev"
}
```

- `git push origin main` → `git push*` (8) → **ask**
- `git push --force origin main` → both match; `git push --force*` (16) beats 8 → **deny**
- `ls && rm -rf build` → stage 1 allow, stage 2 ask → most restrictive → **ask**
- `sudo rm -rf x` → no pattern starts with `sudo` → **allow**. Add `"sudo *"` → ask if that matters.

## 2. Read-only allowlist for a sensitive tree

"In `/srv/prod` it may look but not touch."

```jsonc
{
  "policies": {
    "readonly": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
        { "action": "allow", "tool": "find" },
        { "action": "allow", "tool": "ls" },
        { "action": "allow", "tool": "bash", "pattern": "$safe-bash" },
        { "action": "allow", "tool": "bash", "pattern": "cd *" }
      ]
    }
  },
  "locations": { "/srv/prod": "readonly" }
}
```

- `write /srv/prod/app.conf` → no rule for `write` → default **deny** (path wording: "blocked path").
- `cat /srv/prod/app.conf` → `cat *` is in `$safe-bash` → **allow**.
- `sed -i s/a/b/ /srv/prod/app.conf` → `sed -i` isn't in `$safe-bash` → **deny**.
- Note: calls from a cwd elsewhere that touch `/srv/prod` are still covered, because the policy follows the *target path*, not the cwd.
- **Watch tool hiding:** if `readonly` is the *only* active policy, `write` and `edit` are universally denied and get removed from the agent everywhere (bash stays, because of the `$safe-bash` allows). Add a permissive fallback such as `"defaultPolicy": "open"` with `"open": { "defaultAction": "allow", "rules": [] }`.

## 3. Stricter subfolder inside a relaxed tree

```jsonc
{
  "policies": {
    "open":   { "defaultAction": "allow", "rules": [] },
    "strict": {
      "defaultAction": "ask",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "$safe-bash" }
      ]
    }
  },
  "locations": {
    "/home/me/work":            "open",
    "/home/me/work/production": "strict"
  }
}
```

- `edit /home/me/work/production/x.ts` → longest location is `…/production` → strict → **ask**.
- `cp /home/me/work/a /home/me/work/production/a` → targets hit open (allow) and strict (`cp` not in `$safe-bash` → default ask) → **ask**.

## 4. Protect secrets from every tool

"Never let it read keys or .env files, whatever tool it uses."

```jsonc
{
  "pathProtection": {
    "*.env":           "deny",
    ".env.*":          "deny",
    "id_rsa*":         "deny",
    "id_ed25519*":     "deny",
    "*.pem":           "deny",
    "**/.ssh/**":      "deny",
    "**/.aws/credentials": "deny"
  }
}
```

- Checked before any policy, approval, or session allow, and it applies even in `inform` mode.
- Globs match the basename or the full canonical path. **Don't use `~`**, which isn't expanded here.
- Only `"deny"` has an effect in `pathProtection`.
- For bash, pathProtection checks every whitespace-separated token starting with `/`, `~`, or `.`, plus the parsed targets. So `cat .env` and `cat ~/.ssh/id_rsa` are caught, but `cat secrets.env` (a bare filename) is not. It's airtight for file tools and good-but-not-perfect for bash.

## 5. Steer the agent to better tools

```jsonc
{
  "policies": {
    "dev": {
      "defaultAction": "allow",
      "rules": [
        { "action": "nudge", "tool": "bash", "pattern": "grep *", "message": "Use the grep tool instead of bash grep." },
        { "action": "nudge", "tool": "bash", "pattern": "find *", "message": "Use the find tool instead of bash find." }
      ]
    }
  },
  "nudgeTimeout": { "maxNudges": 3, "windowSeconds": 120 }
}
```

- A nudge doesn't fire on a piped stage that reads stdin (`bun test | grep FAIL`), and a file dump feeding a pipe (`cat x | jq`) doesn't trigger a read-tool nudge.
- After 3 ignored nudges for the same rule within 120 s, the next one is **denied** with the nudge text, then the counter resets.

## 6. Audit only

```jsonc
{
  "policies": { "audit": { "defaultAction": "log", "rules": [] } },
  "defaultPolicy": "audit"
}
```

Or keep the real policy and run `/controls inform` to preview what would be blocked.

## 7. Model-backed fallthrough (`auto`)

"Allow the obvious, block the obvious, let the model judge the rest."

```jsonc
{
  "policies": {
    "cwd": {
      "defaultAction": "auto",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "$safe-bash" },
        { "action": "ask",   "tool": "bash", "pattern": "git push*" }
      ]
    }
  },
  "defaultPolicy": "cwd",
  "decisions": {
    "tokenEnv": "OPENROUTER_API_KEY",
    "auto": { "deny": true }
  }
}
```

- `git status` → `$safe-bash` → **allow** (no API call).
- `git push` → explicit ask beats auto → **ask**.
- `curl -X POST … -d @.env` → no rule → `auto` → model → likely **deny** (exfil shape).
- See [decisions-auto.md](decisions-auto.md) for tuning and data-egress caveats.

## 8. Rogue-agent circuit breaker

```jsonc
{ "agentTimeout": { "maxDenies": 3, "windowSeconds": 60 } }
```

After 3 denies in 60 s, further denies become **ask**, so the user can step in. Pair it with strict `deny` policies.

## 9. Gate specific MCP / custom tools

```jsonc
{
  "policies": {
    "dev": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask",  "tool": "github_merge_pull_request" },
        { "action": "deny", "tool": "github_delete_*" },
        { "action": "log",  "tool": "github_*" }
      ]
    }
  },
  "defaultPolicy": "dev"
}
```

- MCP tools usually have no path input, so their target is the cwd, and the policy for the cwd applies.
- `github_delete_repo` → `github_delete_*` (14) beats `github_*` (7) → **deny**.
- `github_merge_pull_request` → exact name (25) → **ask**.

## 10. Project overrides a global policy

Global:

```jsonc
{ "policies": { "dev": { "defaultAction": "allow", "rules": [ { "action": "ask", "tool": "bash", "pattern": "rm *" } ] } },
  "defaultPolicy": "dev" }
```

Project `.pi/extensions/pi-controls.jsonc`:

```jsonc
{ "policies": { "dev": { "rules": [ { "action": "deny", "tool": "bash", "pattern": "git push*" } ] } } }
```

The merged `dev` policy keeps `defaultAction: "allow"`, but its rules are **only** the project's `git push*` deny. The global `rm *` ask is gone, because arrays replace. To keep both, copy the global rules into the project file, or use a differently named project policy mapped with `"$cwd": "dev-project"`.
