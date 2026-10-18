import { describe, expect, it } from "vitest";
import { llmsTxt } from "../src/llms";

describe("llms.txt", () => {
  it("documents the publish response as one parseable JSON object", () => {
    const section = llmsTxt("example.com").match(/## Response \(JSON\)\n([\s\S]*?)\n## /)![1]!;
    const opened = section.split("{").length - 1;
    expect(section.split("}").length - 1).toBe(opened);
    const example = section.slice(section.indexOf("{"), section.indexOf("\n}") + 2).replace(/\s+\/\/.*$/gm, "");
    expect(Object.keys(JSON.parse(example))).toEqual(["url", "username", "ownerToken"]);
  });
});
