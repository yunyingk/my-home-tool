import { mode, number, text } from "./normalize.ts";
import { isRecord, XiaoduError, XiaoduTransport } from "./transport.ts";
import type { AirConditionerCommand, AirConditionerMode, Appliance, ControlSubmission, PreparedControl, RawObject } from "./types.ts";

const COMMANDS = {
  turnOn: { directive: "TurnOnRequest", capability: "turnOn" },
  turnOff: { directive: "TurnOffRequest", capability: "turnOff" },
  setMode: { directive: "SetModeRequest", capability: "setMode" },
  increaseTemperature: { directive: "IncrementTemperatureRequest", capability: "incrementTemperature" },
  decreaseTemperature: { directive: "DecrementTemperatureRequest", capability: "decrementTemperature" },
  increaseFanSpeed: { directive: "IncrementFanSpeedRequest", capability: "incrementFanSpeed" },
  decreaseFanSpeed: { directive: "DecrementFanSpeedRequest", capability: "decrementFanSpeed" },
} as const;

export class AirConditioner {
  constructor(private readonly transport: XiaoduTransport, private readonly loadDevice: () => Promise<Appliance>) {}

  async preview(command: AirConditionerCommand): Promise<PreparedControl> {
    if (!command || !Object.hasOwn(COMMANDS, command.action)) throw new XiaoduError("INVALID_ARGUMENT", "Unsupported air-conditioner command.", { outcome: "not-sent" });
    const device = await this.loadDevice();
    if (!device.types.includes("AIR_CONDITION") || device.controlType !== "__speaker_ir__") {
      throw new XiaoduError("UNSUPPORTED_ACTION", "This version supports speaker infrared air conditioners only.", { outcome: "not-sent" });
    }
    if (device.online === false) throw new XiaoduError("DEVICE_OFFLINE", "The controlling device is offline.", { outcome: "not-sent" });
    const mapping = COMMANDS[command.action];
    if (!device.supportActions.includes(mapping.capability)) throw new XiaoduError("UNSUPPORTED_ACTION", "Device does not advertise this action.", { outcome: "not-sent" });
    if (command.action === "setMode") {
      if (typeof command.mode !== "string" || !device.airConditionerCapabilities.some(capability => capability.mode === command.mode)) {
        throw new XiaoduError("UNSUPPORTED_ACTION", "Mode is not in this device's advertised capabilities.", { outcome: "not-sent" });
      }
    }
    if (["increaseTemperature", "decreaseTemperature", "increaseFanSpeed", "decreaseFanSpeed"].includes(command.action)) {
      const currentMode = mode(device.state.attributes.mode?.value);
      const capability = device.airConditionerCapabilities.find(item => item.mode === currentMode);
      const temperature = command.action.endsWith("Temperature");
      const current = number(temperature ? device.state.attributes.temperature?.value ?? device.state.attributes.targetTemperature?.value : device.state.attributes.fanSpeed?.value);
      const min = temperature ? capability?.minTemperature : capability?.minFanSpeed;
      const max = temperature ? capability?.maxTemperature : capability?.maxFanSpeed;
      if (current === null || min === null || min === undefined || max === null || max === undefined || min > max) {
        throw new XiaoduError("UNAVAILABLE_STATE", "Current platform value or mode-specific control range is unavailable.", { outcome: "not-sent" });
      }
      const next = current + (command.action.startsWith("increase") ? 1 : -1);
      if (next < min || next > max) throw new XiaoduError("OUT_OF_RANGE", "Command exceeds this mode's advertised range, based on the platform record.", { outcome: "not-sent" });
    }
    const payload: RawObject = {
      ...(command.action === "setMode" ? { mode: { value: command.mode } } : {}),
      applianceId: device.id,
      appliance: { applianceId: [device.id] },
      parameters: { proxyConnectStatus: false },
    };
    return {
      deviceId: device.id, deviceName: device.name, command, verification: "request-construction-only", platformState: device.state,
      request: { method: "POST", url: "https://xiaodu.baidu.com/saiya/smarthome/directivesend?from=h5_control", body: { header: { namespace: "DuerOS.ConnectedHome.Control", name: mapping.directive, payloadVersion: 1 }, payload } },
    };
  }

  async execute(command: AirConditionerCommand): Promise<ControlSubmission> {
    const prepared = await this.preview(command);
    const response = await this.transport.request("control", { query: { from: "h5_control" }, body: prepared.request.body, mutating: true });
    if (!isRecord(response.data)) throw new XiaoduError("INVALID_RESPONSE", "Control response is missing its data object. The write outcome is unknown.", { outcome: "unknown" });
    const serverStatus = text(response.data.status ?? response.data.result);
    if (serverStatus && ["failed", "FAILED"].includes(serverStatus)) throw new XiaoduError("COMMAND_REJECTED", "Xiaodu reported that the control command failed.", { outcome: "rejected" });
    return { deviceId: prepared.deviceId, deviceName: prepared.deviceName, command, outcome: "accepted", physicalStateVerified: false, serverStatus, taskId: text(response.data.task_id ?? response.data.taskId), raw: response };
  }

  turnOn() { return this.execute({ action: "turnOn" }); }
  turnOff() { return this.execute({ action: "turnOff" }); }
  setMode(mode: AirConditionerMode) { return this.execute({ action: "setMode", mode }); }
  increaseTemperature() { return this.execute({ action: "increaseTemperature" }); }
  decreaseTemperature() { return this.execute({ action: "decreaseTemperature" }); }
  increaseFanSpeed() { return this.execute({ action: "increaseFanSpeed" }); }
  decreaseFanSpeed() { return this.execute({ action: "decreaseFanSpeed" }); }
}
