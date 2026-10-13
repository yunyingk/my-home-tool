import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./fixtures/scenes.json";
import { XiaoduClient } from "../src/index.ts";
import type { RawObject } from "../src/index.ts";

const folders: string[] = [];
afterAll(async () => { for (const path of folders) await rm(path, { recursive: true, force: true }); });

async function harness(options: { catalog?: RawObject; detail?: RawObject; capabilities?: RawObject; failMethod?: string; pauseUpdate?: () => Promise<void>; folder?: string } = {}) {
  const folder = options.folder ?? await mkdtemp(join(tmpdir(), "my-home-tool-scenes-"));
  if (!options.folder) folders.push(folder);
  const requests: RawObject[] = [];
  const writes: string[] = [];
  const client = new XiaoduClient({ bduss: "test-scene-session", sceneLockDirectory: folder, fetch: async (url, init) => {
    expect(url).toBe("https://xiaodu.baidu.com/saiya/smarthome/unified");
    const body = JSON.parse(String(init.body)); requests.push(body);
    let data: unknown;
    switch (body.method) {
      case "generalScenes": data = options.catalog ?? fixture.catalog; break;
      case "getSceneAppliances": data = options.capabilities ?? fixture.capabilities; break;
      case "getRecommendScene": data = fixture.template; break;
      case "generalDetailScenes": data = options.detail ?? fixture.detail; break;
      case "createScene": case "updateScene": case "triggerScene":
        writes.push(body.method);
        if (options.failMethod === body.method) return Response.json({ status: 8, msg: "operation failed" });
        if (body.method === "updateScene") await options.pauseUpdate?.();
        data = body.method === "createScene" ? { sceneId: "new-scene-1" } : {};
        break;
      default: throw new Error("Unexpected method");
    }
    return Response.json({ status: 0, msg: "ok", data });
  } });
  return { client, requests, writes, folder };
}

describe("scene reads and previews", () => {
  test("catalog distinguishes saved scenes from recommendations and parses nested IDs", async () => {
    const { client, writes } = await harness();
    const result = await client.getSceneCatalog();
    expect(result.mine[0]).toMatchObject({ id: "scene-1", configured: true });
    expect(result.recommended[0]).toMatchObject({ id: null, configured: false });
    expect(writes).toHaveLength(0);
  });

  test("reads current speaker-specific capabilities using the observed protocol", async () => {
    const { client, requests } = await harness();
    expect(await client.getSceneCapabilities("小度1s")).toMatchObject({ speaker: { clientId: "speaker-client-1", online: true }, supportsSpeech: true, supportsCustomQuery: true });
    expect(requests[0]).toEqual({ method: "getSceneAppliances", from: "h5", version: "2.0", params: { isSceneTemplate: false, from: "index-add", sceneType: "CUSTOM" } });
  });

  test("reads saved details and rejects nonexistent scenes without guessing IDs", async () => {
    const { client } = await harness();
    expect(await client.getSceneDetail("scene-1")).toEqual(fixture.detail);
    await expect(client.getSceneDetail("missing")).rejects.toMatchObject({ code: "SCENE_NOT_FOUND" });
  });

  test("creation preview uses a dedicated name, current UI structure, JSON text and system volume", async () => {
    const { client, writes } = await harness({ catalog: { ...fixture.catalog, myScenes: [] } });
    const text = '包含"引号"与\n换行';
    const result = await client.previewCreateSpeechScene({ speaker: "小度1s", text });
    const params = result.requests[0]!.body.params as RawObject;
    expect(params).toMatchObject({ sceneName: "my-home-tool播报", sceneType: "CUSTOM", cuid: "speaker-cuid-1", clientId: "speaker-client-1", conditionTrigger: { or: [], and: [], validperiod: [], andCondType: 0 } });
    expect(params.sceneBlocks).toEqual([{ blockType: "broadcastTTS", tts: text, cuid: "speaker-cuid-1", clientId: "speaker-client-1", volume: -1 }]);
    expect(JSON.parse(JSON.stringify(params)).sceneBlocks[0].tts).toBe(text);
    expect(writes).toHaveLength(0);
  });

  test("never overwrites a scene when the creation name already exists", async () => {
    const { client, writes } = await harness();
    await expect(client.previewCreateSpeechScene({ speaker: "小度1s", text: "你好" })).rejects.toMatchObject({ code: "SCENE_NAME_CONFLICT" });
    expect(writes).toHaveLength(0);
  });

  test("enforces the current 300-character text limit and volume constraints before API calls", async () => {
    const { client, requests } = await harness();
    for (const text of ["", " ", "字".repeat(301)]) await expect(client.previewCreateSpeechScene({ speaker: "小度1s", text })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    for (const volume of [-2, 101, 1.5]) await expect(client.previewCreateSpeechScene({ speaker: "小度1s", text: "你好", volume })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(requests).toHaveLength(0);
  });

  test("rejects unavailable TTS support and offline speakers", async () => {
    const capability = structuredClone(fixture.capabilities); capability.client[0]!.supportAbility.broadcastTTS = false;
    const empty = { ...fixture.catalog, myScenes: [] };
    await expect((await harness({ catalog: empty, capabilities: capability })).client.previewCreateSpeechScene({ speaker: "小度1s", text: "你好" })).rejects.toMatchObject({ code: "UNSUPPORTED_ACTION" });
    capability.client[0]!.supportAbility.broadcastTTS = true; capability.client[0]!.onlineStatus = false;
    await expect((await harness({ catalog: empty, capabilities: capability })).client.previewCreateSpeechScene({ speaker: "小度1s", text: "你好" })).rejects.toMatchObject({ code: "DEVICE_OFFLINE" });
  });

  test("speech preview retains block IDs and metadata and emits update then trigger without sending either", async () => {
    const { client, writes } = await harness();
    const result = await client.previewSpeech({ speaker: "小度1s", sceneId: "scene-1", text: "新文本", volume: 20 });
    expect(result.requests.map(item => item.body.method)).toEqual(["updateScene", "triggerScene"]);
    const params = result.requests[0]!.body.params as RawObject;
    expect(params.unmappedServerField).toEqual({ retained: true });
    expect(params.sceneBlocks).toMatchObject([{ blockId: "block-1", tts: "新文本", volume: 20 }]);
    expect(fixture.detail.sceneBlocks[0]!.tts).toBe("之前的文本");
    expect(writes).toHaveLength(0);
  });

  test("current saved details omit top-level clientId; verify the block and restore it for update", async () => {
    const detail: RawObject = structuredClone(fixture.detail);
    delete detail.clientId;
    const { client, writes } = await harness({ detail });
    const prepared = await client.previewSpeech({ speaker: "小度1s", sceneId: "scene-1", text: "你好" });
    expect(prepared.requests[0]!.body.params).toMatchObject({ clientId: "speaker-client-1", cuid: "speaker-cuid-1" });
    expect(writes).toHaveLength(0);
  });

  test("rejects unrelated names, other speakers, mixed actions and automatic conditions", async () => {
    const changes: RawObject[] = [
      { sceneType: "MORNING" }, { cuid: "other-speaker" }, { clientId: "other-client" },
      { sceneBlocks: [...fixture.detail.sceneBlocks, { blockType: "smarthome" }] },
      { timing: [{ time: "08:00" }] }, { conditionTrigger: { or: [{ blockType: "sensor" }] } },
      { conditionTrigger: "unknown-format" },
      { changeDisable: { sceneEnable: ["another-scene"] } }, { changeDisable: "unknown-format" },
      { pannelTrigger: [{ applianceId: "another-device" }] }, { triggerPush: true },
      { sceneBlocks: [{ ...fixture.detail.sceneBlocks[0], cuid: "other-speaker" }] },
    ];
    for (const change of changes) {
      const { client, writes } = await harness({ detail: { ...fixture.detail, ...change } });
      await expect(client.previewSpeech({ speaker: "小度1s", sceneId: "scene-1", text: "你好" })).rejects.toMatchObject({ code: "UNSAFE_SCENE" });
      expect(writes).toHaveLength(0);
    }
    const catalog = structuredClone(fixture.catalog); catalog.myScenes[0]!.name = "我的日常场景";
    await expect((await harness({ catalog })).client.previewSpeech({ speaker: "小度1s", sceneId: "scene-1", text: "你好" })).rejects.toMatchObject({ code: "UNSAFE_SCENE" });
  });

  test("only accepts the server-advertised triggerScene method", async () => {
    const catalog = structuredClone(fixture.catalog); catalog.myScenes[0]!.trigger.sceneParams.method = "deleteScene";
    const { client, writes } = await harness({ catalog });
    await expect(client.previewRunScene("scene-1")).rejects.toMatchObject({ code: "UNSUPPORTED_ACTION" });
    expect(writes).toHaveLength(0);
  });
});

describe("scene writes with mock transport", () => {
  test("creation returns a saved ID and releases its private lock", async () => {
    const { client, writes, folder } = await harness({ catalog: { ...fixture.catalog, myScenes: [] } });
    expect(await client.createSpeechScene({ speaker: "小度1s", text: "你好" })).toMatchObject({ sceneId: "new-scene-1", outcome: "saved", physicalStateVerified: false });
    expect(writes).toEqual(["createScene"]);
    expect(await readdir(folder)).toHaveLength(0);
  });

  test("speech submits update then trigger and never claims audible playback", async () => {
    const { client, writes, folder } = await harness();
    expect(await client.speak({ speaker: "小度1s", sceneId: "scene-1", text: "你好" })).toMatchObject({ outcome: "accepted", physicalStateVerified: false });
    expect(writes).toEqual(["updateScene", "triggerScene"]);
    expect(await readdir(folder)).toHaveLength(0);
  });

  test("an update error prevents triggering and includes the failing phase", async () => {
    const { client, writes, folder } = await harness({ failMethod: "updateScene" });
    await expect(client.speak({ speaker: "小度1s", sceneId: "scene-1", text: "你好" })).rejects.toMatchObject({ code: "API_ERROR", details: { phase: "update" } });
    expect(writes).toEqual(["updateScene"]);
    expect(await readdir(folder)).toHaveLength(0);
  });

  test("a trigger error is not retried and does not roll back the saved text", async () => {
    const { client, writes } = await harness({ failMethod: "triggerScene" });
    await expect(client.speak({ speaker: "小度1s", sceneId: "scene-1", text: "你好" })).rejects.toMatchObject({ details: { phase: "trigger" } });
    expect(writes).toEqual(["updateScene", "triggerScene"]);
  });

  test("independent clients share a file lock even when one uses a scene name and one an ID", async () => {
    let release = () => {};
    let started = () => {};
    const paused = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { started = resolve; });
    const first = await harness({ pauseUpdate: async () => { started(); await paused; } });
    const second = await harness({ folder: first.folder });
    const pending = first.client.speak({ speaker: "小度1s", sceneId: "scene-1", text: "第一条" });
    await reached;
    try {
      await expect(second.client.speak({ speaker: "小度1s", sceneId: "my-home-tool播报", text: "第二条" })).rejects.toMatchObject({ code: "SCENE_BUSY", details: { outcome: "not-sent" } });
      expect(second.writes).toHaveLength(0);
    } finally { release(); }
    await pending;
    expect(first.writes).toEqual(["updateScene", "triggerScene"]);
  });
});
