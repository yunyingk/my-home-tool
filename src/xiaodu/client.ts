import { AirConditioner } from "./air-conditioner.ts";
import { appliance, house, records, rooms, selectDevice, speaker } from "./normalize.ts";
import { parseScenes, XiaoduScenes } from "./scenes.ts";
import { requireRecord, XiaoduTransport } from "./transport.ts";
import type { Snapshot, SpeechOptions, SpeechSceneOptions, XiaoduClientOptions } from "./types.ts";

export class XiaoduClient {
  #transport: XiaoduTransport;
  #scenes: XiaoduScenes;

  constructor(options: XiaoduClientOptions) {
    this.#transport = new XiaoduTransport(options);
    this.#scenes = new XiaoduScenes(this.#transport, options.sceneLockDirectory);
  }

  async getSnapshot(): Promise<Snapshot> {
    const response = await this.#transport.request("appliances", { body: { method: "GET_USER_ALL_APPLIANCES", params: { from: "h5_control", withscene: 1, generalscene: 3, version: "2.0" } } });
    const raw = requireRecord(response.data, "Missing device snapshot data.");
    return {
      speakers: records(raw.client, "client").map(speaker),
      appliances: records(raw.appliances, "appliances").map(appliance),
      rooms: rooms(raw.groupInfo), scenes: parseScenes(raw.sceneInfos), raw,
    };
  }

  async listSpeakers() { return (await this.getSnapshot()).speakers; }
  async listAppliances() { return (await this.getSnapshot()).appliances; }
  async listScenes() { return (await this.getSnapshot()).scenes; }
  getSceneCatalog() { return this.#scenes.catalog(); }
  getSceneCapabilities(speaker: string) { return this.#scenes.capabilities(speaker); }
  getSceneDetail(scene: string) { return this.#scenes.detail(scene); }
  previewRunScene(scene: string) { return this.#scenes.previewRun(scene); }
  runScene(scene: string) { return this.#scenes.run(scene); }
  previewCreateSpeechScene(input: SpeechSceneOptions) { return this.#scenes.previewCreateSpeech(input); }
  createSpeechScene(input: SpeechSceneOptions) { return this.#scenes.createSpeech(input); }
  previewSpeech(input: SpeechOptions) { return this.#scenes.previewSpeech(input); }
  speak(input: SpeechOptions) { return this.#scenes.speak(input); }

  async listRooms() {
    const response = await this.#transport.request("rooms", { method: "GET", query: { from: "H5", method: "GROUP_INFO" } });
    return rooms(response.data);
  }

  async listHouses() {
    const response = await this.#transport.request("houses", { body: { method: "HOUSE_LIST", params: { entityId: "", entityType: "" } } });
    return records(requireRecord(response.data, "Missing house data.").houseList, "houseList").map(house);
  }

  async getSpeakerBindings(selector: string) {
    const device = selectDevice(await this.listSpeakers(), selector, item => item.clientId, item => item.name);
    const response = await this.#transport.request("bindings", { body: { method: "GET_CLIENT_DETAILS", params: { clientId: device.clientId, version: 1, from: "h5" } } });
    return records(requireRecord(response.data, "Missing speaker binding data.").deviceList, "deviceList").map(appliance);
  }

  airConditioner(selector: string): AirConditioner {
    return new AirConditioner(this.#transport, async () => selectDevice(await this.listAppliances(), selector, item => item.id, item => item.name));
  }
}
