import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiptOf } from "../core/antigravity-inbox";
import { ocMessageId, ocRemoteTick, OcRemoteDeps } from "./remote";

const S = "ses_remote000000000000000001";
const NOW = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function setup(files: Record<string, string>, over: Partial<OcRemoteDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oc-remote-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  const calls: string[] = [];
  const deps: OcRemoteDeps = {
    dir, owns: async (id) => id === S, now: () => NOW, trace: () => {},
    published: (id) => calls.push(`published ${id}`),
    prompt: async (i) => { calls.push(`prompt ${i.text} ${i.id}`); },
    interrupt: async (i) => { calls.push(`interrupt ${i.sessionID}`); return { interrupted: true }; },
    ...over,
  };
  await ocRemoteTick(deps);
  return { dir, calls };
}
const inbox = (mid: string, text: string, ts = 1) => ({ [`${S}.${mid}.agy-inbox`]: JSON.stringify({ mid, text, ts }) });

describe("ocRemoteTick", () => {
  test("messages are delivered oldest first, receipted d, then the row is republished once", async () => {
    const { dir, calls } = await setup({ ...inbox("bbbbbbbb", "second", 2), ...inbox("aaaaaaaa", "first", 1) });
    expect(calls).toEqual([`prompt first ${ocMessageId("aaaaaaaa")}`, `prompt second ${ocMessageId("bbbbbbbb")}`, `published ${S}`]);
    expect(await receiptOf(dir, S, "aaaaaaaa")).toBe("d");
    expect((await readdir(dir)).filter((n) => n.endsWith(".agy-inbox"))).toEqual([]);
  });

  test("no prompt on this OpenCode → refused (x), never left queued", async () => {
    const { dir } = await setup(inbox("aaaaaaaa", "hi"), { prompt: undefined });
    expect(await receiptOf(dir, S, "aaaaaaaa")).toBe("x");
  });

  test("a conflict on our own id means it was admitted already (d); any other failure is x", async () => {
    const conflict = await setup(inbox("aaaaaaaa", "hi"), {
      prompt: async () => { throw Object.assign(new Error("dup"), { _tag: "Session.PromptConflictError" }); },
    });
    expect(await receiptOf(conflict.dir, S, "aaaaaaaa")).toBe("d");
    const broken = await setup(inbox("aaaaaaaa", "hi"), { prompt: async () => { throw new Error("NotFound"); } });
    expect(await receiptOf(broken.dir, S, "aaaaaaaa")).toBe("x");
  });

  test("files of sessions we do not own (or not OpenCode's) are left alone", async () => {
    const { dir, calls } = await setup({
      "ses_other.aaaaaaaa.agy-inbox": JSON.stringify({ mid: "aaaaaaaa", text: "x", ts: 1 }),
      "c0ffee00-0000.aaaaaaaa.agy-inbox": JSON.stringify({ mid: "aaaaaaaa", text: "x", ts: 1 }),
      "ses_other.oc-interrupt": JSON.stringify({ at: NOW }),
    });
    expect(calls).toEqual([]);
    expect((await readdir(dir)).length).toBe(3);
  });

  test("a fresh interrupt flag is consumed and interrupts; a stale or unreadable one is consumed and dropped", async () => {
    const fresh = await setup({ [`${S}.oc-interrupt`]: JSON.stringify({ at: NOW - 5_000 }) });
    expect(fresh.calls).toEqual([`interrupt ${S}`]);
    expect(await readdir(fresh.dir)).toEqual([]);
    const stale = await setup({ [`${S}.oc-interrupt`]: JSON.stringify({ at: NOW - 121_000 }) });
    expect(stale.calls).toEqual([]);
    expect(await readdir(stale.dir)).toEqual([]);
    const junk = await setup({ [`${S}.oc-interrupt`]: "nope" });
    expect(junk.calls).toEqual([]);
  });
});
