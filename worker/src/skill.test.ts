import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import { apexApp } from "./apex";
import files from "./gen/skill";

const landing = new Response("landing", { status: 404 });
const env = (apexHost: string) => ({ APEX_HOST: apexHost, ASSETS: { fetch: async () => landing.clone() } }) as unknown as Env;
const get = (path: string, apexHost: string) => apexApp.fetch(new Request(`https://${apexHost}${path}`), env(apexHost));

describe("/skill/", () => {
  it("serves every file of skills/agenthost", () => {
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "references/http-api.md"]);
  });

  it.each(Object.keys(files))("serves %s unchanged on agenthost.page", async (path) => {
    const response = await get(`/skill/${path}`, "agenthost.page");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toBe(files[path]);
  });

  it.each(Object.keys(files))("points %s at a self-hosted apex", async (path) => {
    const text = await (await get(`/skill/${path}`, "example.com")).text();
    expect(text).not.toContain("agenthost.page");
    expect(text).toContain("https://example.com/");
    expect(text).toContain("{username}-{id}.example.com");
  });

  it("keeps the rest of the skill text as written", async () => {
    const text = await (await get("/skill/SKILL.md", "example.com")).text();
    expect(text).toBe(files["SKILL.md"]!.replaceAll("agenthost.page", "example.com"));
    expect(text).toContain("name: agenthost\n");
  });

  it.each(["/skill/", "/skill/nope.md", "/skill/references/", "/skill/../wrangler.jsonc"])("falls through to the landing page for %s", async (path) => {
    const response = await get(path, "agenthost.page");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("landing");
  });
});
