/**
 * Colmi R02 BLE protocol — encode/decode 16-byte packets.
 *
 * Service UUID: 6e40fff0-b5a3-f393-e0a9-e50e24dcca9e
 * TX (notify):  6e400003-b5a3-f393-e0a9-e50e24dcca9e
 * RX (write):   6e400002-b5a3-f393-e0a9-e50e24dcca9e
 */

export const COLMI_SERVICE_UUID = "6e40fff0-b5a3-f393-e0a9-e50e24dcca9e";
export const COLMI_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
export const COLMI_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

// Command 0x69 = real-time data request
const CMD_REAL_TIME = 0x69;

export enum RealTimeType {
  HEART_RATE = 1,
  BLOOD_PRESSURE = 2,
  SPO2 = 3,
  FATIGUE = 4,
  STRESS = 5,
}

// Command 0xA1 = raw sensor streaming
const CMD_RAW_SENSOR = 0xa1;

export enum RawSensorType {
  SPO2_RAW = 1,
  PPG_RAW = 2,
  ACCELEROMETER = 3,
}

function checksum(packet: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += packet[i];
  return sum % 255;
}

export function buildRealTimeCommand(
  type: RealTimeType,
  start: boolean
): ArrayBuffer {
  const cmd = new Uint8Array(16);
  cmd[0] = CMD_REAL_TIME;
  cmd[1] = type;
  cmd[2] = start ? 1 : 0;
  cmd[15] = checksum(cmd);
  return cmd.buffer as ArrayBuffer;
}

export function buildRawSensorCommand(
  type: RawSensorType,
  start: boolean
): ArrayBuffer {
  const cmd = new Uint8Array(16);
  cmd[0] = CMD_RAW_SENSOR;
  cmd[1] = start ? 0x04 : 0x02;
  cmd[15] = checksum(cmd);
  return cmd.buffer as ArrayBuffer;
}

export interface ParsedReading {
  command: number;
  type: number;
  heartRate?: number;
  spo2?: number;
  accelX?: number;
  accelY?: number;
  accelZ?: number;
  rawPpg?: number;
}

export function parseNotification(data: DataView): ParsedReading | null {
  if (data.byteLength < 4) return null;

  const command = data.getUint8(0);
  const type = data.getUint8(1);

  if (command === CMD_REAL_TIME) {
    // HR/SpO2 value is at byte[3] — only use it when non-zero
    // Bytes 6-7 are raw PPG sensor data, NOT HR/SpO2
    const value = data.getUint8(3);

    if (type === RealTimeType.HEART_RATE && value >= 40 && value <= 200) {
      return { command, type, heartRate: value };
    }
    if (type === RealTimeType.SPO2 && value >= 70 && value <= 100) {
      return { command, type, spo2: value };
    }

    // Even if HR/SpO2 not ready, extract raw PPG from bytes 6-7 if present
    if (data.byteLength >= 8) {
      const rawPpg = data.getUint16(6, true);
      if (rawPpg > 0) {
        return { command, type, rawPpg };
      }
    }
  }

  if (command === CMD_RAW_SENSOR) {
    const subtype = data.getUint8(1);

    if (subtype === RawSensorType.ACCELEROMETER && data.byteLength >= 8) {
      const x = data.getInt16(2, true) / 1000;
      const y = data.getInt16(4, true) / 1000;
      const z = data.getInt16(6, true) / 1000;
      return { command, type: subtype, accelX: x, accelY: y, accelZ: z };
    }

    if (subtype === RawSensorType.PPG_RAW && data.byteLength >= 4) {
      const ppg = data.getUint16(2, true);
      return { command, type: subtype, rawPpg: ppg };
    }
  }

  return null;
}
