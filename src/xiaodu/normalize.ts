import { isRecord, requireRecord, XiaoduError } from "./transport.ts";
import type { AirConditionerCapability, Appliance, House, PlatformAttribute, PlatformState, RawObject, Room, Speaker } from "./types.ts";

export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

export function number(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function records(value: unknown, field: string): RawObject[] {
  if (!Array.isArray(value) || value.some(item => !isRecord(item))) throw new XiaoduError("INVALID_RESPONSE", `Expected an object array in ${field}.`);
  return value;
}

function requiredText(value: unknown, field: string): string {
  const result = text(value);
  if (result === null) throw new XiaoduError("INVALID_RESPONSE", `Missing ${field}.`);
  return result;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function mode(value: unknown): string | null {
  const v = text(value);
  if (!v) return null;
  const names: Record<string, string> = { "0": "COOL", "1": "HEAT", "2": "AUTO", "3": "FAN", "4": "DEHUMIDIFICATION", 制冷: "COOL", 制热: "HEAT", 自动: "AUTO", 送风: "FAN", 除湿: "DEHUMIDIFICATION", 睡眠: "SLEEP" };
  return Object.hasOwn(names, v) ? names[v]! : v.toUpperCase();
}

function platformState(raw: RawObject): PlatformState {
  const attributes = isRecord(raw.attributes) ? raw.attributes : {};
  const settings = isRecord(raw.stateSetting) ? raw.stateSetting : {};
  const result: Record<string, PlatformAttribute> = Object.create(null);
  for (const key of new Set([...Object.keys(attributes), ...Object.keys(settings)])) {
    const attribute = isRecord(attributes[key]) ? attributes[key] : {};
    const setting = isRecord(settings[key]) ? settings[key] : {};
    const sampledAt = attribute.timestampOfSample ?? setting.time;
    result[key] = { value: setting.value ?? attribute.value ?? null, sampledAt: typeof sampledAt === "number" || typeof sampledAt === "string" ? sampledAt : null };
  }
  return { source: "platform-record", physicalStateVerified: false, attributes: result };
}

export function speaker(raw: RawObject): Speaker {
  return {
    clientId: requiredText(raw.client_id ?? raw.clientId, "speaker clientId"),
    cuid: requiredText(raw.cuid, "speaker cuid"),
    name: requiredText(raw.name, "speaker name"), product: text(raw.product),
    online: typeof raw.online_status === "boolean" ? raw.online_status : null,
    roomName: text(raw.groupName ?? raw.group_name), firmwareVersion: text(raw.device_version), raw,
  };
}

export function appliance(raw: RawObject): Appliance {
  const additional = isRecord(raw.additional_appliance_details) ? raw.additional_appliance_details : {};
  const capabilityData = raw.airConditionSupportAttributes ?? additional.air_condition_support_attributes;
  const capabilities: AirConditionerCapability[] = (capabilityData === undefined ? [] : records(capabilityData, "air-conditioner capabilities")).map(item => ({
    mode: requiredText(mode(item.mode), "capability mode"),
    minTemperature: number(item.minTemperature ?? item.minT), maxTemperature: number(item.maxTemperature ?? item.maxT),
    minFanSpeed: number(item.minFanSpeed ?? item.minS), maxFanSpeed: number(item.maxFanSpeed ?? item.maxS),
  }));
  let online: boolean | null = null;
  if (typeof raw.isClientOnline === "boolean") online = raw.isClientOnline;
  else if (["1", "0"].includes(String(raw.is_reachable))) online = String(raw.is_reachable) === "1";
  const state = platformState(raw);
  const connectivity = text(state.attributes.connectivity?.value)?.toUpperCase();
  if (online === null && ["REACHABLE", "UNREACHABLE"].includes(connectivity ?? "")) online = connectivity === "REACHABLE";
  return {
    id: requiredText(raw.applianceId ?? raw.appliance_id, "appliance ID"), name: requiredText(raw.friendlyName ?? raw.friendly_name, "appliance name"),
    types: strings(raw.applianceTypes ?? raw.appliance_types), controlType: text(raw.botId ?? raw.bot_name),
    speakerClientId: text(raw.clientId ?? additional.client_id), online, roomName: text(raw.roomName ?? raw.groupName ?? raw.group_name),
    supportActions: strings(raw.supportActions ?? raw.actions), state, airConditionerCapabilities: capabilities, raw,
  };
}

export function rooms(value: unknown): Room[] {
  const raw = requireRecord(value, "Missing room data.");
  const floors = records(raw.floorList ?? raw.groupList, "floor/room list");
  return floors.flatMap(floor => records(floor.roomList ?? floor.groupList, "rooms").map(room => ({
    id: requiredText(room.roomId ?? room.groupId, "room ID"), name: requiredText(room.roomName ?? room.groupName, "room name"),
    floorId: text(floor.floorId), floorName: text(floor.floorName), raw: room,
  })));
}

export function house(raw: RawObject): House {
  return { id: requiredText(raw.houseId, "house ID"), name: requiredText(raw.houseName, "house name"), isDefault: raw.isDefault === true, isOwner: raw.isOwner === true, raw };
}

export function selectDevice<T>(items: T[], selector: string, identifier: (value: T) => string, name: (value: T) => string): T {
  if (!selector.trim()) throw new XiaoduError("INVALID_ARGUMENT", "A nonempty device identifier or unique name is required.", { outcome: "not-sent" });
  const byId = items.filter(item => identifier(item) === selector);
  const matches = byId.length ? byId : items.filter(item => name(item) === selector);
  if (matches.length === 0) throw new XiaoduError("DEVICE_NOT_FOUND", "Device was not found in this account.", { outcome: "not-sent" });
  if (matches.length > 1) throw new XiaoduError("AMBIGUOUS_DEVICE", "Device name or identifier is ambiguous. Use a unique device ID.", { outcome: "not-sent" });
  return matches[0]!;
}
