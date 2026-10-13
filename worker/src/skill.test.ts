import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import worker from "./index";
import { credentialsCommand, renderTemplate, skillFiles, writeCredentialsCommand } from "./skill";
import type { Env } from "./env";

const baseEnv = {
  APEX_HOST: "example.com",
  ASSETS: { fetch: async (req: Request) => new Response(`asset ${new URL(req.url).pathname}`, { status: 404 }) },
} as unknown as Env;
const get = (path: string, env: Partial<Env> = {}) =>
  worker.fetch(new Request(`https://example.com${path}`), { ...baseEnv, ...env }, {} as ExecutionContext);

describe("served skill", () => {
  it("renders SKILL.md for the deployment's apex host and limits", async () => {
    const res = await get("/skill/SKILL.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = await res.text();
    expect(body).toContain("\nname: example-com\n");
    expect(body).toContain("\nversion: 0.4.0\n");
    expect(body).toContain("homepage: https://example.com\n");
    expect(body).toContain("curl -fsSL https://example.com/skill/install.sh | sh");
    expect(body).toContain("curl -s -K ~/.config/agenthost/example.com.curlrc --data-binary @report.md 'https://example.com/publish?id=report'");
    expect(body).toContain("`test -f ~/.config/agenthost/example.com.curlrc`");
    expect(body).toContain(`    (f="$HOME/.config/agenthost/example.com.curlrc"; mkdir -p "\${f%/*}" && umask 077 || exit; printf 'example.com username: ' >&2; read -r u; trap 'stty echo 2>/dev/null; exit 130' INT HUP TERM; stty -echo 2>/dev/null; printf 'example.com token (hidden): ' >&2; read -r t; stty echo 2>/dev/null; echo >&2; [ -n "$u" ] && [ -n "$t" ] || exit 1; printf 'header = "Authorization: Bearer %s"\\nheader = "x-agenthost-user: %s"\\n' "$t" "$u" > "$f" && chmod 600 "$f" && echo "Saved $f" >&2)\n`);
    expect(body).toContain(`    mkdir -p ~/.config/agenthost && (umask 077 && printf 'header = "Authorization: Bearer %s"\\nheader = "x-agenthost-user: %s"\\n' 'OWNER_TOKEN' 'USERNAME' > ~/.config/agenthost/example.com.curlrc) && chmod 600 ~/.config/agenthost/example.com.curlrc\n`);
    expect(body).not.toContain("Bearer TOKEN");
    expect(body).not.toContain("username=");
    expect(body).toContain("- Free: 50 files, 5 MB per file, 250 MB per site, 500 MB per account");
    expect(body).toContain("[references/http-api.md](references/http-api.md), also served at `https://example.com/skill/references/http-api.md`");
    for (const file of Object.keys(skillFiles)) expect(body).toContain(`\`${file}\``);
    expect(body).not.toContain("{{");
    expect(body).not.toContain("agenthost.page");
  });

  it("renders the HTTP reference with a relative link back to SKILL.md", async () => {
    const res = await get("/skill/references/http-api.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Base URL: `https://example.com`.");
    expect(body).toContain("[SKILL.md](../SKILL.md)");
    expect(body).not.toContain("https://example.com/skill/SKILL.md");
    expect(body).toContain("| Files per site | 50 | 1000 |");
    expect(body).toContain("| Size per site | 250 MB | 1 GB |");
    expect(body).toContain("| Single asset | 100 MB | 5 GB |");
    expect(body).toContain("curl -s -K ~/.config/agenthost/example.com.curlrc -X POST 'https://example.com/key/rotate?id=myblog'");
    expect(body).not.toContain("{{");
    expect(body).not.toContain("agenthost.page");
  });

  it("names the skill after SKILL_NAME when set", async () => {
    const body = await (await get("/skill/SKILL.md", { SKILL_NAME: "my-host" })).text();
    expect(body).toContain("\nname: my-host\n");
    expect(body).toContain("into `my-host/` under");
  });

  it.each(["/skill/SKILL.md", "/skill/references/http-api.md", "/skill/install.sh"])(
    "fails %s loudly on a SKILL_NAME agents would not load",
    async (path) => {
      const res = await get(path, { SKILL_NAME: "Bad Name" });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: 'skill name "Bad Name" is not a valid Agent Skill name (lowercase letters, digits and single hyphens, at most 64 characters); set SKILL_NAME',
      });
    },
  );

  it("leaves other /skill/ paths to static assets", async () => {
    const res = await get("/skill/nope.md");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("asset /skill/nope.md");
  });
});

describe("installer", () => {
  it("serves a POSIX sh script for the apex", async () => {
    const res = await get("/skill/install.sh");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body).toContain('name="example-com"');
    expect(body).toContain('base="https://example.com/skill"');
    expect(body).toContain('files="SKILL.md references/http-api.md"');
    expect(body).toContain(`  if [ "$name" != agenthost ] && [ -e "$root/agenthost" ]; then
    echo "Found an older install at $root/agenthost; remove it to avoid two copies of the skill."
  fi
`);
  });
});

describe("install.sh", () => {
  // Runs the rendered script with a curl stub that copies from a tree of the
  // worker's own responses, so every file the skill serves must be installed.
  it("installs every skill file, keeping its path", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "skill-install-"));
    const served = join(tmp, "served");
    for (const file of Object.keys(skillFiles)) {
      mkdirSync(dirname(join(served, file)), { recursive: true });
      writeFileSync(join(served, file), await (await get(`/skill/${file}`)).text());
    }
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    https://example.com/skill/*) file="\${1#https://example.com/skill/}" ;;
  esac
  shift
done
cp "${served}/$file" "$out"
`,
      { mode: 0o755 },
    );
    const home = join(tmp, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    execFileSync("/bin/sh", ["-c", `PATH="${bin}:$PATH" HOME="${home}" sh -s`], { input: await (await get("/skill/install.sh")).text() });
    for (const file of Object.keys(skillFiles)) {
      expect(readFileSync(join(home, ".claude/skills/example-com", file), "utf8")).toBe(readFileSync(join(served, file), "utf8"));
    }
  });
});

describe("credentialsCommand", () => {
  it("prompts for the username and the hidden token, so the command holds no secret", () => {
    expect(credentialsCommand("example.com")).toBe(
      `(f="$HOME/.config/agenthost/example.com.curlrc"; mkdir -p "\${f%/*}" && umask 077 || exit; printf 'example.com username: ' >&2; read -r u; trap 'stty echo 2>/dev/null; exit 130' INT HUP TERM; stty -echo 2>/dev/null; printf 'example.com token (hidden): ' >&2; read -r t; stty echo 2>/dev/null; echo >&2; [ -n "$u" ] && [ -n "$t" ] || exit 1; printf 'header = "Authorization: Bearer %s"\\nheader = "x-agenthost-user: %s"\\n' "$t" "$u" > "$f" && chmod 600 "$f" && echo "Saved $f" >&2)`,
    );
  });

  it("bakes in a given username and prompts only for the token", () => {
    expect(credentialsCommand("example.com", "ana")).toBe(
      `(f="$HOME/.config/agenthost/example.com.curlrc"; mkdir -p "\${f%/*}" && umask 077 || exit; u='ana'; trap 'stty echo 2>/dev/null; exit 130' INT HUP TERM; stty -echo 2>/dev/null; printf 'example.com token (hidden): ' >&2; read -r t; stty echo 2>/dev/null; echo >&2; [ -n "$u" ] && [ -n "$t" ] || exit 1; printf 'header = "Authorization: Bearer %s"\\nheader = "x-agenthost-user: %s"\\n' "$t" "$u" > "$f" && chmod 600 "$f" && echo "Saved $f" >&2)`,
    );
  });

  it("shell-quotes a username with a single quote", () => {
    expect(credentialsCommand("example.com", "o'b")).toContain(`; u='o'\\''b'; `);
  });
});

describe("writeCredentialsCommand", () => {
  it("writes the two headers non-interactively with owner-only permissions", () => {
    expect(writeCredentialsCommand("example.com")).toBe(
      `mkdir -p ~/.config/agenthost && (umask 077 && printf 'header = "Authorization: Bearer %s"\\nheader = "x-agenthost-user: %s"\\n' 'OWNER_TOKEN' 'USERNAME' > ~/.config/agenthost/example.com.curlrc) && chmod 600 ~/.config/agenthost/example.com.curlrc`,
    );
  });
});

describe("renderTemplate", () => {
  it("substitutes every placeholder", () => {
    expect(renderTemplate("{{a}} and {{b}}", { a: "x", b: "y" })).toBe("x and y");
  });

  it("throws on a placeholder it has no value for", () => {
    expect(() => renderTemplate("{{a}} {{missing}}", { a: "x" })).toThrow("unknown template variable {{missing}}");
  });
});
