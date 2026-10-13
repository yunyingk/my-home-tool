export type RawObject = Record<string, unknown>;

export interface Speaker {
  clientId: string;
  cuid: string;
  name: string;
  product: string | null;
  online: boolean | null;
  roomName: string | null;
  firmwareVersion: string | null;
  raw: RawObject;
}

export interface PlatformAttribute {
  value: unknown;
  sampledAt: string | number | null;
}

export interface PlatformState {
  source: "platform-record";
  physicalStateVerified: false;
  attributes: Record<string, PlatformAttribute>;
}

export type AirConditionerMode = "COOL" | "HEAT" | "AUTO" | "FAN" | "DEHUMIDIFICATION" | "SLEEP";

export interface AirConditionerCapability {
  mode: string;
  minTemperature: number | null;
  maxTemperature: number | null;
  minFanSpeed: number | null;
  maxFanSpeed: number | null;
}

export interface Appliance {
  id: string;
  name: string;
  types: string[];
  controlType: string | null;
  speakerClientId: string | null;
  online: boolean | null;
  roomName: string | null;
  supportActions: string[];
  state: PlatformState;
  airConditionerCapabilities: AirConditionerCapability[];
  raw: RawObject;
}

export interface Room {
  id: string;
  name: string;
  floorId: string | null;
  floorName: string | null;
  raw: RawObject;
}

export interface House {
  id: string;
  name: string;
  isDefault: boolean;
  isOwner: boolean;
  raw: RawObject;
}

export interface Scene {
  id: string | null;
  name: string;
  type: string | null;
  configured: boolean;
  raw: RawObject;
}

export interface Snapshot {
  speakers: Speaker[];
  appliances: Appliance[];
  rooms: Room[];
  scenes: Scene[];
  raw: RawObject;
}

export type AirConditionerCommand =
  | { action: "turnOn" | "turnOff" | "increaseTemperature" | "decreaseTemperature" | "increaseFanSpeed" | "decreaseFanSpeed" }
  | { action: "setMode"; mode: AirConditionerMode };

export interface PreparedControl {
  deviceId: string;
  deviceName: string;
  command: AirConditionerCommand;
  verification: "request-construction-only";
  platformState: PlatformState;
  request: {
    method: "POST";
    url: string;
    body: RawObject;
  };
}

export interface ControlSubmission {
  deviceId: string;
  deviceName: string;
  command: AirConditionerCommand;
  outcome: "accepted";
  physicalStateVerified: false;
  serverStatus: string | null;
  taskId: string | null;
  raw: RawObject;
}

export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

export interface XiaoduClientOptions {
  /** The value of the BDUSS cookie, without the BDUSS= prefix. */
  bduss: string;
  timeoutMs?: number;
  /** Supply a transport for tests; production uses the runtime's fetch. */
  fetch?: FetchFunction;
}
