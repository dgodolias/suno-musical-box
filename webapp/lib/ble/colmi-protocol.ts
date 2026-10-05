/** COLMI UART commands. Reference: https://colmi.puxtril.com/commands/#data-request */
export const COLMI_SERVICE_UUID = "6e40fff0-b5a3-f393-e0a9-e50e24dcca9e";
export const COLMI_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
export const COLMI_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

export type HeartRateMode = "standard" | "legacy" | "realtime";

const PACKET_LENGTH = 16;
const CMD_BATTERY = 0x03;
const CMD_REAL_TIME = 0x69;
const CMD_REAL_TIME_HEART_RATE = 0x1e;
const CMD_STOP_REAL_TIME = 0x6a;
const CMD_RAW_SENSOR = 0xa1;

export enum RealTimeType {
  HEART_RATE = 1,
  BLOOD_PRESSURE = 2,
  SPO2 = 3,
  FATIGUE = 4,
  STRESS = 5,
  REAL_TIME_HEART_RATE = 6,
}

export enum RawSensorType {
  SPO2_RAW = 1,
  PPG_RAW = 2,
  ACCELEROMETER = 3,
}

function packet(...values: number[]): ArrayBuffer {
  const bytes = new Uint8Array(PACKET_LENGTH);
  bytes.set(values);
  bytes[15] = bytes.slice(0, 15).reduce((sum, value) => sum + value, 0) & 0xff;
  return bytes.buffer;
}

export function buildBatteryCommand(): ArrayBuffer {
  return packet(CMD_BATTERY);
}

export function buildRealTimeCommand(type: RealTimeType, start: boolean): ArrayBuffer {
  return start ? packet(CMD_REAL_TIME, type, 1) : buildStopCommand(type);
}

export function buildHeartRateStartCommand(mode: HeartRateMode): ArrayBuffer {
  // Gadgetbridge's manual-HR request uses a zero-padded 69 01 packet.
  // Keep this explicit: action 0 here is a legacy START, never our STOP API.
  const type = mode === "realtime" ? RealTimeType.REAL_TIME_HEART_RATE : RealTimeType.HEART_RATE;
  return packet(CMD_REAL_TIME, type, mode === "legacy" ? 0 : 1);
}

export function buildContinueHRCommand(): ArrayBuffer {
  // RingCLI uses START_REAL_TIME with action CONTINUE (3), not a new START.
  return packet(CMD_REAL_TIME, RealTimeType.HEART_RATE, 3);
}

export function buildStopCommand(type: RealTimeType): ArrayBuffer {
  return packet(CMD_STOP_REAL_TIME, type);
}

export function buildRawSensorCommand(type: RawSensorType, start: boolean): ArrayBuffer {
  // Legacy API: this switch is global on the supported firmware, not per sensor.
  // Raw mode is deliberately not enabled by the acquisition manager.
  void type;
  return packet(CMD_RAW_SENSOR, start ? 0x04 : 0x02);
}

/** Isolated UART diagnostic only; never an OTA or firmware command. */
export function buildOpticalDiagnosticCommand(start: boolean): ArrayBuffer {
  // ATC_RF03_Writer / colmi-ring-tools: A1 04 04 starts, A1 02 stops.
  return start ? packet(CMD_RAW_SENSOR, 0x04, 0x04) : packet(CMD_RAW_SENSOR, 0x02);
}

export function hasValidFixedPacketChecksum(data: DataView): boolean {
  if (data.byteLength !== PACKET_LENGTH) return false;
  let sum = 0;
  for (let index = 0; index < PACKET_LENGTH - 1; index++) sum += data.getUint8(index);
  return (sum & 0xff) === data.getUint8(PACKET_LENGTH - 1);
}

export interface ParsedReading {
  command: number;
  type: number;
  status?: "reading" | "warming-up" | "error" | "invalid" | "ack";
  errorCode?: number;
  error?: string;
  heartRate?: number;
  spo2?: number;
  batteryLevel?: number;
  isCharging?: boolean;
  accelX?: number;
  accelY?: number;
  accelZ?: number;
  rawPpg?: number;
}

export function parseNotification(data: DataView): ParsedReading | null {
  if (data.byteLength < 2) return null;
  const command = data.getUint8(0);
  const type = data.getUint8(1);

  // These command responses have the documented fixed 16-byte framing.
  // Raw sensor framing varies by firmware and is not subject to this check.
  if ([CMD_BATTERY, CMD_REAL_TIME, CMD_REAL_TIME_HEART_RATE, CMD_STOP_REAL_TIME].includes(command)) {
    if (data.byteLength !== PACKET_LENGTH) {
      return { command, type, status: "invalid", error: `Expected 16 bytes, received ${data.byteLength}` };
    }
    let sum = 0;
    for (let index = 0; index < 15; index++) sum += data.getUint8(index);
    if ((sum & 0xff) !== data.getUint8(15)) {
      return { command, type, status: "invalid", error: "Invalid packet checksum" };
    }
  }

  if (command === CMD_BATTERY) {
    if (type > 100) return { command, type, status: "invalid", error: "Invalid battery level" };
    return { command, type: 0, status: "reading", batteryLevel: type, isCharging: data.getUint8(2) === 1 };
  }

  if (command === CMD_STOP_REAL_TIME) return { command, type, status: "ack" };

  // https://colmi.puxtril.com/commands/#realtime-heart-rate specifies opcode
  // 0x1e and HR at byte 1. Some firmware instead replies with 0x69/type 6.
  if (command === CMD_REAL_TIME_HEART_RATE) {
    return type === 0
      ? { command, type: RealTimeType.REAL_TIME_HEART_RATE, status: "warming-up" }
      : { command, type: RealTimeType.REAL_TIME_HEART_RATE, status: "reading", heartRate: type };
  }

  if (command === CMD_REAL_TIME) {
    const errorCode = data.getUint8(2);
    const value = data.getUint8(3);
    if (errorCode !== 0) {
      // Firmware error-code meanings are undocumented; preserve the actual code.
      return { command, type, status: "error", errorCode, error: `Ring measurement error 0x${errorCode.toString(16).padStart(2, "0")}` };
    }
    if (value === 0) return { command, type, status: "warming-up" };
    if (type === RealTimeType.HEART_RATE || type === RealTimeType.REAL_TIME_HEART_RATE) {
      // Type 6 shares the generic 0x69 value layout in the captured R02_V3.0
      // and RT02R_V3.1 traces. Keep the device's nonzero byte value.
      return { command, type, status: "reading", heartRate: value };
    }
    if (type === RealTimeType.SPO2 && value <= 100) {
      return { command, type, status: "reading", spo2: value };
    }
    return { command, type, status: "ack" };
  }

  // Preserve the existing raw decoder; it is not requested automatically.
  if (command === CMD_RAW_SENSOR) {
    if (type === RawSensorType.ACCELEROMETER && data.byteLength >= 8) {
      return {
        command, type,
        accelX: data.getInt16(2, true) / 1000,
        accelY: data.getInt16(4, true) / 1000,
        accelZ: data.getInt16(6, true) / 1000,
      };
    }
    if (type === RawSensorType.PPG_RAW && data.byteLength >= 4) {
      return { command, type, rawPpg: data.getUint16(2, true) };
    }
  }
  return null;
}
