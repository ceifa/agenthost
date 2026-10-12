import { describe, expect, it } from "vitest";
import worker from "./index";
import { renderTemplate } from "./skill";
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
    expect(body).toContain("https://example.com/publish?id=report");
    expect(body).toContain("- Free: 50 files, 5 MB per file, 250 MB per site, 500 MB per account");
    expect(body).toContain("[references/http-api.md](https://example.com/skill/references/http-api.md)");
    expect(body).not.toContain("{{");
    expect(body).not.toContain("agenthost.page");
  });

  it("renders the HTTP reference with an absolute link back to SKILL.md", async () => {
    const res = await get("/skill/references/http-api.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Base URL: `https://example.com`.");
    expect(body).toContain("[SKILL.md](https://example.com/skill/SKILL.md)");
    expect(body).toContain("| Files per site | 50 | 1000 |");
    expect(body).toContain("| Size per site | 250 MB | 1 GB |");
    expect(body).toContain("| Single asset | 100 MB | 5 GB |");
    expect(body).not.toContain("{{");
    expect(body).not.toContain("agenthost.page");
  });

  it("names the skill after SKILL_NAME when set", async () => {
    const body = await (await get("/skill/SKILL.md", { SKILL_NAME: "my-host" })).text();
    expect(body).toContain("\nname: my-host\n");
    expect(body).toContain("`my-host/SKILL.md`");
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
    expect(body).toContain('url="https://example.com/skill/SKILL.md"');
    expect(body).toContain(`  if [ "$name" != agenthost ] && [ -e "$root/agenthost" ]; then
    echo "Found an older install at $root/agenthost; remove it to avoid two copies of the skill."
  fi
`);
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
