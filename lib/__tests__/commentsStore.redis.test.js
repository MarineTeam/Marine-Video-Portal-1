// lib/commentsStore.js against a REAL redis-server: the add script's cap, the
// round trip through the stored JSON, and removal with the video.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evalScript, shouldSkip, startRedis } from "./helpers/localRedis";

let server;
let r;

function toObject(flat) {
  if (!flat || !flat.length) return null;
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

// The Upstash client's shapes. Like the real client, a JSON-looking value
// comes back parsed — the store must cope with both.
const parse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};
const adapter = {
  hgetall: async (key) => {
    const obj = toObject(await r.call("HGETALL", key));
    return obj && Object.fromEntries(Object.entries(obj).map(([f, v]) => [f, parse(v)]));
  },
  hget: async (key, field) => {
    const raw = await r.call("HGET", key, field);
    return raw === null ? null : parse(raw);
  },
  hdel: (key, ...fields) => r.call("HDEL", key, ...fields),
  del: (key) => r.call("DEL", key),
  eval: (script, keys, args) => evalScript(r, script, keys, args),
};

vi.mock("../redis", () => ({
  redis: adapter,
  k: (key) => `pvp:${key}`,
}));

const store = await import("../commentsStore");
const { MAX_COMMENTS_PER_VIDEO } = await import("../comments");

const jane = { email: "jane@example.com", name: "Jane Smith", text: "Amen" };

describe.skipIf(shouldSkip)("comments on a real redis-server", () => {
  beforeAll(async () => {
    server = await startRedis();
    r = server.client;
  });
  afterAll(async () => {
    await server?.stop();
  });
  beforeEach(async () => {
    await r.call("FLUSHALL");
  });

  it("stores comments per video and lists them oldest first", async () => {
    await store.addComment("vid-1", { ...jane, text: "second" }, 2000);
    await store.addComment("vid-1", { ...jane, text: "first" }, 1000);
    await store.addComment("vid-2", { ...jane, text: "elsewhere" }, 1500);
    expect((await store.listComments("vid-1")).map((c) => c.text)).toEqual(["first", "second"]);
    expect((await store.listComments("vid-2")).map((c) => c.text)).toEqual(["elsewhere"]);
  });

  it("reads back exactly what was written", async () => {
    const { comment } = await store.addComment("vid-1", jane, 1000);
    expect(await store.getComment("vid-1", comment.id)).toEqual({ id: comment.id, ...jane, at: 1000 });
  });

  it("refuses a comment once the video is at its cap, and writes nothing", async () => {
    const fill = [];
    for (let i = 0; i < MAX_COMMENTS_PER_VIDEO; i += 1) {
      fill.push(`c${String(i).padStart(8, "0")}`, JSON.stringify({ id: `c${i}`, ...jane, at: i }));
    }
    await r.call("HSET", "pvp:comments:vid-1", ...fill);
    expect(await store.addComment("vid-1", jane)).toEqual({ ok: false, error: "full" });
    expect(await r.call("HLEN", "pvp:comments:vid-1")).toBe(MAX_COMMENTS_PER_VIDEO);
  });

  it("deletes one comment, and ignores an id that is not one", async () => {
    const { comment } = await store.addComment("vid-1", jane, 1000);
    await store.addComment("vid-1", { ...jane, text: "keep" }, 2000);
    // A field that is not a comment id is never touched, even if one exists.
    await r.call("HSET", "pvp:comments:vid-1", "not-an-id", "x");
    await store.deleteComment("vid-1", "not-an-id");
    expect(await r.call("HEXISTS", "pvp:comments:vid-1", "not-an-id")).toBe(1);
    await r.call("HDEL", "pvp:comments:vid-1", "not-an-id");
    await store.deleteComment("vid-1", comment.id);
    expect((await store.listComments("vid-1")).map((c) => c.text)).toEqual(["keep"]);
  });

  it("removes every comment on a video, and only that video's", async () => {
    await store.addComment("vid-1", jane, 1000);
    await store.addComment("vid-2", jane, 1000);
    await store.clearComments("vid-1");
    expect(await store.listComments("vid-1")).toEqual([]);
    expect(await store.listComments("vid-2")).toHaveLength(1);
  });

});
