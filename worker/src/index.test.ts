import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import worker from "./index";
import { apexApp } from "./apex";

vi.mock("./apex", () => ({
  apexApp: { fetch: vi.fn(() => new Response("apex")) },
}));

const env = { APEX_HOST: "agenthost.page" } as Env;
const ctx = {} as ExecutionContext;

beforeEach(() => vi.clearAllMocks());

describe("apex canonical URLs", () => {
  it.each([
    ["http://agenthost.page/", "https://agenthost.page/"],
    ["https://www.agenthost.page/guides/publish-with-claude-code?ref=docs", "https://agenthost.page/guides/publish-with-claude-code?ref=docs"],
    ["http://www.agenthost.page/", "https://agenthost.page/"],
  ])("permanently redirects %s to %s", async (from, to) => {
    const response = await worker.fetch(new Request(from), env, ctx);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(to);
    expect(apexApp.fetch).not.toHaveBeenCalled();
  });

  it("also redirects HEAD requests", async () => {
    const response = await worker.fetch(new Request("https://www.agenthost.page/", { method: "HEAD" }), env, ctx);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://agenthost.page/");
  });

  it("serves canonical requests without a redirect", async () => {
    const request = new Request("https://agenthost.page/");
    const response = await worker.fetch(request, env, ctx);
    expect(await response.text()).toBe("apex");
    expect(apexApp.fetch).toHaveBeenCalledWith(request, env, ctx);
  });

  it("uses the configured apex for self-hosted instances", async () => {
    const response = await worker.fetch(new Request("https://www.example.com/"), { ...env, APEX_HOST: "example.com" }, ctx);
    expect(response.headers.get("location")).toBe("https://example.com/");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("passes %s API requests through with their body and authorization", async (method) => {
    const request = new Request("https://www.agenthost.page/publish?id=report", {
      method,
      body: "report bytes",
      headers: { authorization: "Bearer test-owner-token" },
    });
    await worker.fetch(request, env, ctx);
    expect(apexApp.fetch).toHaveBeenCalledWith(request, env, ctx);
    expect(await request.text()).toBe("report bytes");
    expect(request.headers.get("authorization")).toBe("Bearer test-owner-token");
  });

  it("keeps local HTTP development working", async () => {
    const request = new Request("http://localhost:8787/?__host=www.agenthost.page");
    const devEnv = { ...env, DEV_MODE: "1" };
    await worker.fetch(request, devEnv, ctx);
    expect(apexApp.fetch).toHaveBeenCalledWith(request, devEnv, ctx);
  });

  it("does not treat a hosted-site subdomain as an apex alias", async () => {
    // An unknown subdomain keeps its existing 404 behavior, with no apex redirect.
    const response = await worker.fetch(new Request("https://unknown.agenthost.page/"), env, ctx);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(apexApp.fetch).not.toHaveBeenCalled();
  });
});
