import { records, selectDevice, speaker, text } from "./normalize.ts";
import { isRecord, requireRecord, XiaoduError, XiaoduTransport } from "./transport.ts";
import { withSceneLock } from "./scene-lock.ts";
import type { PreparedSceneOperation, RawObject, Scene, SceneCapabilities, SceneCatalog, SceneRequest, SceneSubmission, SpeechOptions, SpeechSceneOptions } from "./types.ts";

/** Read scene metadata only. Execution and TTS need a separately verified scene. */
export function parseScenes(value: unknown): Scene[] {
  return records(value, "sceneInfos").map(raw => {
    const params = isRecord(raw.sceneParams) && isRecord(raw.sceneParams.params) ? raw.sceneParams.params : {};
    const name = text(raw.name);
    if (!name) throw new XiaoduError("INVALID_RESPONSE", "Missing scene name.");
    return { id: text(raw.sceneId ?? params.sceneId), name, type: text(raw.type), configured: raw.isSet === 1 || raw.isSet === true, raw };
  });
}

const URL = "https://xiaodu.baidu.com/saiya/smarthome/unified";

function sceneParams(value: unknown): RawObject {
  if (!isRecord(value) || !isRecord(value.sceneParams) || !isRecord(value.sceneParams.params)) return {};
  return value.sceneParams.params;
}

function catalogScenes(value: unknown, field: string): Scene[] {
  return records(value, field).map(raw => {
    const id = text(raw.sceneId ?? sceneParams(raw.detailScene).sceneId ?? sceneParams(raw.trigger).sceneId ?? sceneParams(raw).sceneId);
    const name = text(raw.name ?? raw.sceneName);
    if (!name) throw new XiaoduError("INVALID_RESPONSE", "Missing scene name.");
    return { id, name, type: text(raw.type ?? raw.sceneType), configured: raw.isSet !== 0 && id !== null, raw };
  });
}

function validateSpeech(input: { text: string; volume?: number }) {
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 300) throw new XiaoduError("INVALID_ARGUMENT", "Speech must contain 1–300 UTF-16 characters, matching the current webpage limit.", { outcome: "not-sent" });
  const volume = input.volume ?? -1;
  if (!Number.isInteger(volume) || (volume !== -1 && (volume < 0 || volume > 100))) throw new XiaoduError("INVALID_ARGUMENT", "Volume must be -1 (system volume) or an integer from 0 to 100.", { outcome: "not-sent" });
  return volume;
}

function request(method: string, params?: RawObject): SceneRequest {
  return { method: "POST", url: URL, body: { method, from: "h5", version: "2.0", ...(params ? { params } : {}) } };
}

export class XiaoduScenes {
  constructor(private readonly transport: XiaoduTransport, private readonly lockDirectory?: string) {}

  private async read(method: string, params?: RawObject): Promise<RawObject> {
    const response = await this.transport.request("scenes", { body: request(method, params).body });
    return requireRecord(response.data, "Missing scene data.");
  }

  async catalog(): Promise<SceneCatalog> {
    const raw = await this.read("generalScenes");
    return { mine: catalogScenes(raw.myScenes, "myScenes"), thirdParty: catalogScenes(raw.thirdPartyScenes, "thirdPartyScenes"), recommended: catalogScenes(raw.recommendScenes, "recommendScenes"), raw };
  }

  async capabilities(selector: string): Promise<SceneCapabilities> {
    const raw = await this.read("getSceneAppliances", { isSceneTemplate: false, from: "index-add", sceneType: "CUSTOM" });
    const selected = selectDevice(records(raw.client, "scene client").map(speaker), selector, item => item.clientId, item => item.name);
    const ability = isRecord(raw.sceneAbility) ? raw.sceneAbility : {};
    const support = isRecord(selected.raw.supportAbility) ? selected.raw.supportAbility : {};
    return { speaker: selected, supportsSpeech: ability.broadcastTTS === true && support.broadcastTTS === true, supportsCustomQuery: ability.customQuery === true && support.customQuery === true, raw };
  }

  private async mine(selector: string): Promise<Scene> {
    const catalog = await this.catalog();
    const found = catalog.mine.filter(scene => scene.id === selector);
    const matches = found.length ? found : catalog.mine.filter(scene => scene.name === selector);
    if (matches.length === 0) throw new XiaoduError("SCENE_NOT_FOUND", "No matching saved scene exists in this account.", { outcome: "not-sent" });
    if (matches.length !== 1) throw new XiaoduError("AMBIGUOUS_DEVICE", "Scene name is ambiguous; use its ID.", { outcome: "not-sent" });
    if (!matches[0]!.id || !matches[0]!.configured) throw new XiaoduError("UNSAFE_SCENE", "The selected scene is not configured.", { outcome: "not-sent" });
    return matches[0]!;
  }

  async detail(selector: string): Promise<RawObject> {
    const scene = await this.mine(selector);
    return this.read("generalDetailScenes", { sceneId: scene.id });
  }

  async previewRun(selector: string): Promise<PreparedSceneOperation> {
    const scene = await this.mine(selector);
    const trigger = isRecord(scene.raw.trigger) && isRecord(scene.raw.trigger.sceneParams) ? scene.raw.trigger.sceneParams : null;
    if (!trigger || trigger.method !== "triggerScene" || sceneParams(scene.raw.trigger).sceneId !== scene.id) {
      throw new XiaoduError("UNSUPPORTED_ACTION", "This scene does not expose the verified triggerScene protocol.", { outcome: "not-sent" });
    }
    return { verification: "request-construction-only", requests: [request("triggerScene", { sceneId: scene.id })] };
  }

  private async submit(prepared: SceneRequest, sceneId?: string): Promise<SceneSubmission> {
    const response = await this.transport.request("scenes", { body: prepared.body, mutating: true });
    const data = isRecord(response.data) ? response.data : {};
    const id = sceneId ?? text(data.sceneId);
    if (!id) throw new XiaoduError("INVALID_RESPONSE", "Scene submission was accepted without a scene ID. The write outcome is unknown.", { outcome: "unknown" });
    return { sceneId: id, outcome: prepared.body.method === "triggerScene" ? "accepted" : "saved", physicalStateVerified: false, raw: response };
  }

  async run(selector: string): Promise<SceneSubmission> {
    const prepared = await this.previewRun(selector);
    const id = String((prepared.requests[0]!.body.params as RawObject).sceneId);
    return withSceneLock(this.lockDirectory, `scene:${id}`, () => this.submit(prepared.requests[0]!, id));
  }

  async previewCreateSpeech(input: SpeechSceneOptions): Promise<PreparedSceneOperation> {
    const volume = validateSpeech(input);
    const name = input.name ?? "my-home-tool播报";
    if (typeof name !== "string" || !name.startsWith("my-home-tool") || name.length > 30) throw new XiaoduError("INVALID_ARGUMENT", "Dedicated scene names must start with my-home-tool and be at most 30 characters.", { outcome: "not-sent" });
    const catalog = await this.catalog();
    if (catalog.mine.some(scene => scene.name === name)) throw new XiaoduError("SCENE_NAME_CONFLICT", "A scene already uses this name; existing scenes are never overwritten during creation.", { outcome: "not-sent" });
    const capability = await this.capabilities(input.speaker);
    if (!capability.supportsSpeech) throw new XiaoduError("UNSUPPORTED_ACTION", "This speaker does not advertise scene TTS support.", { outcome: "not-sent" });
    if (capability.speaker.online === false) throw new XiaoduError("DEVICE_OFFLINE", "The selected speaker is offline.", { outcome: "not-sent" });
    const template = await this.read("getRecommendScene", { sceneType: "CUSTOM" });
    const target = capability.speaker;
    const params = {
      ...template, sceneName: name, sceneType: "CUSTOM", cuid: target.cuid, clientId: target.clientId,
      groupName: ["全屋"], floorName: "", queryList: [{ query: `打开${name}场景` }], isCloseQueryTrigger: false,
      timing: [], conditionTrigger: { or: [], and: [], validperiod: [], andCondType: 0 },
      changeDisable: { sceneEnable: [], sceneDisable: [] }, broadcastRes: {},
      sceneBlocks: [{ blockType: "broadcastTTS", tts: input.text, cuid: target.cuid, clientId: target.clientId, volume }],
      sceneDeleteBlocks: [],
      isExistSMAppliance: false, isNewRusScene: false, source: "normal",
    };
    return { verification: "request-construction-only", requests: [request("createScene", params)] };
  }

  async createSpeech(input: SpeechSceneOptions): Promise<SceneSubmission> {
    return withSceneLock(this.lockDirectory, `create:${input.name ?? "my-home-tool播报"}`, async () => {
      const prepared = await this.previewCreateSpeech(input);
      return this.submit(prepared.requests[0]!);
    });
  }

  async previewSpeech(input: SpeechOptions): Promise<PreparedSceneOperation> {
    const volume = validateSpeech(input);
    const capability = await this.capabilities(input.speaker);
    if (!capability.supportsSpeech) throw new XiaoduError("UNSUPPORTED_ACTION", "This speaker does not advertise scene TTS support.", { outcome: "not-sent" });
    if (capability.speaker.online === false) throw new XiaoduError("DEVICE_OFFLINE", "The selected speaker is offline.", { outcome: "not-sent" });
    const scene = await this.mine(input.sceneId);
    const detail = await this.read("generalDetailScenes", { sceneId: scene.id });
    const target = capability.speaker;
    const blocks = records(detail.sceneBlocks, "sceneBlocks");
    if (detail.conditionTrigger !== undefined && !isRecord(detail.conditionTrigger)) throw new XiaoduError("UNSAFE_SCENE", "Scene conditions are not in the verified format.", { outcome: "not-sent" });
    if (detail.changeDisable !== undefined && !isRecord(detail.changeDisable)) throw new XiaoduError("UNSAFE_SCENE", "Scene side effects are not in the verified format.", { outcome: "not-sent" });
    const conditions = isRecord(detail.conditionTrigger) ? detail.conditionTrigger : {};
    const sideEffects = isRecord(detail.changeDisable) ? detail.changeDisable : {};
    const arrays = [detail.timing, detail.pannelTrigger, conditions.or, conditions.and, conditions.validperiod, sideEffects.sceneEnable, sideEffects.sceneDisable];
    if (!scene.name.startsWith("my-home-tool") || detail.sceneType !== "CUSTOM" || detail.cuid !== target.cuid || (detail.clientId !== undefined && detail.clientId !== target.clientId) || blocks.length !== 1 || blocks[0]!.blockType !== "broadcastTTS" || detail.triggerPush === true || arrays.some(value => value !== undefined && (!Array.isArray(value) || value.length !== 0))) {
      throw new XiaoduError("UNSAFE_SCENE", "Speech updates require a dedicated my-home-tool scene with one TTS action, matching speaker and no automatic conditions.", { outcome: "not-sent" });
    }
    const block = blocks[0]!;
    if (block.cuid !== target.cuid || block.clientId !== target.clientId) throw new XiaoduError("UNSAFE_SCENE", "The existing TTS block does not explicitly target this speaker.", { outcome: "not-sent" });
    const trigger = await this.previewRun(scene.id!);
    const params = { ...detail, sceneId: scene.id, cuid: target.cuid, clientId: target.clientId, sceneBlocks: [{ ...block, tts: input.text, volume, cuid: target.cuid, clientId: target.clientId }], sceneDeleteBlocks: [] };
    return { verification: "request-construction-only", requests: [request("updateScene", params), trigger.requests[0]!] };
  }

  async speak(input: SpeechOptions): Promise<SceneSubmission> {
    validateSpeech(input);
    const selected = await this.mine(input.sceneId);
    return withSceneLock(this.lockDirectory, `scene:${selected.id}`, async () => {
      const prepared = await this.previewSpeech({ ...input, sceneId: selected.id! });
      const id = String((prepared.requests[0]!.body.params as RawObject).sceneId);
      try { await this.submit(prepared.requests[0]!, id); }
      catch (error) {
        if (error instanceof XiaoduError) throw new XiaoduError(error.code, error.message, { ...error.details, phase: "update" });
        throw error;
      }
      try { return await this.submit(prepared.requests[1]!, id); }
      catch (error) {
        if (error instanceof XiaoduError) throw new XiaoduError(error.code, error.message, { ...error.details, phase: "trigger" });
        throw error;
      }
    });
  }
}
