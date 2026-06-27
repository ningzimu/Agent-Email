import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const cloud = require("../src/services/cloud_attachments.js");

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}

function jsonResponse(data) {
  const text = JSON.stringify(data);
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(Buffer.byteLength(text)) },
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text),
  };
}

function bytesResponse(buf) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(buf.length) : "") },
    text: async () => buf.toString("utf8"),
    arrayBuffer: async () => buf,
  };
}

describe("cloud attachments", () => {
  it("extracts QQ FTN and NetEase cloud links from HTML", () => {
    const html = `
      <a href="https://wx.mail.qq.com/ftn/download?func=3&amp;key=QQKEY&amp;code=abc">QQ</a>
      <a href="https://dashi.163.com/html/cloud-attachment-download/?key=NETEASEKEY">163</a>
    `;
    const sources = cloud.extractCloudAttachmentSources(html);
    expect(sources).toEqual([
      { provider: "qq-ftn", url: "https://wx.mail.qq.com/ftn/download?func=3&key=QQKEY&code=abc" },
      { provider: "netease-cloud", url: "https://dashi.163.com/html/cloud-attachment-download/?key=NETEASEKEY" },
    ]);
  });

  it("downloads a NetEase cloud attachment with mocked HTTP responses", async () => {
    const root = tmpRoot("netease_cloud_download");
    fs.rmSync(root, { recursive: true, force: true });
    const payload = Buffer.from("pptx bytes");
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET" });
      if (String(url).includes("/file/link/info/get")) {
        return jsonResponse({ result: { fileName: "deck.pptx", fileSize: payload.length } });
      }
      if (String(url).includes("/file/dl/prepare2")) {
        return jsonResponse({ result: { downloadUrl: "https://download.example.com/deck.pptx" } });
      }
      if (String(url).startsWith("https://download.example.com/")) return bytesResponse(payload);
      throw new Error(`unexpected fetch ${url}`);
    };

    const result = await cloud.downloadNetEaseCloudAttachment("https://dashi.163.com/html/cloud-attachment-download/?key=abc123xyz", {
      outputDir: root,
      fetchImpl,
    });

    expect(result.provider).toBe("netease-cloud");
    expect(result.filename).toBe("deck.pptx");
    expect(result.size).toBe(payload.length);
    expect(fs.readFileSync(path.join(root, "deck.pptx"))).toEqual(payload);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(result.key).not.toContain("abc123xyz");
  });

  it("parses QQ FTN metadata from the share page API", async () => {
    const fetchImpl = async (url, options = {}) => {
      expect(url).toBe("https://wx.mail.qq.com/ftn/download");
      expect(options.method).toBe("POST");
      return jsonResponse({
        ret: 0,
        body: {
          name: "large.pptx",
          size: 123,
          md5: "abc",
          sha: "def",
          expired_time: 1785164858,
        },
      });
    };

    const meta = await cloud._test.fetchQqFtnMetadata("https://wx.mail.qq.com/ftn/download?func=3&key=qqkey&code=code", { fetchImpl });
    expect(meta).toMatchObject({
      key: "qqkey",
      code: "code",
      name: "large.pptx",
      size: 123,
      md5: "abc",
      sha: "def",
    });
  });
});
