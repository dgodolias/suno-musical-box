/**
 * BLE Ring Manager — scan, connect, disconnect.
 * Uses Web Bluetooth API (Chrome/Edge only).
 */

import {
  COLMI_SERVICE_UUID,
  COLMI_TX_UUID,
  COLMI_RX_UUID,
  buildRealTimeCommand,
  buildContinueHRCommand,
  buildBatteryCommand,
  RealTimeType,
  parseNotification,
} from "./colmi-protocol";

export type ConnectionState = "disconnected" | "scanning" | "connecting" | "connected";

export interface RingData {
  heartRate: number | null;
  spo2: number | null;
  accelX: number | null;
  accelY: number | null;
  accelZ: number | null;
  rawPpg: number | null;
  batteryLevel: number | null;
  isCharging: boolean;
  lastUpdate: number;
}

export class RingConnection {
  device: BluetoothDevice | null = null;
  server: BluetoothRemoteGATTServer | null = null;
  rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  txChar: BluetoothRemoteGATTCharacteristic | null = null;
  state: ConnectionState = "disconnected";
  data: RingData = {
    heartRate: null,
    spo2: null,
    accelX: null,
    accelY: null,
    accelZ: null,
    rawPpg: null,
    batteryLevel: null,
    isCharging: false,
    lastUpdate: 0,
  };
  personId: 1 | 2;
  onStateChange: (state: ConnectionState) => void = () => {};
  onData: (data: RingData) => void = () => {};

  private hrInterval: ReturnType<typeof setInterval> | null = null;

  constructor(personId: 1 | 2) {
    this.personId = personId;
  }

  get name(): string {
    return this.device?.name || "Unknown";
  }

  private setState(state: ConnectionState) {
    this.state = state;
    this.onStateChange(state);
  }

  async scan(): Promise<boolean> {
    if (!navigator.bluetooth) {
      alert("Web Bluetooth is not supported in this browser. Use Chrome or Edge.");
      return false;
    }

    this.setState("scanning");

    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [COLMI_SERVICE_UUID] },
          { namePrefix: "R02" },
          { namePrefix: "COLMI" },
          { namePrefix: "R06" },
          { namePrefix: "R09" },
        ],
        optionalServices: [COLMI_SERVICE_UUID, "de5bf728-d711-4e47-af26-65e3012a5dc7"],
      });

      if (!this.device) {
        this.setState("disconnected");
        return false;
      }

      this.device.addEventListener("gattserverdisconnected", () => {
        this.setState("disconnected");
        this.stopPolling();
      });

      return await this.connect();
    } catch {
      // User cancelled the picker or no device found — not an error
      this.setState("disconnected");
      return false;
    }
  }

  async connect(): Promise<boolean> {
    if (!this.device) return false;

    this.setState("connecting");

    try {
      this.server = await this.device.gatt!.connect();
      const service = await this.server.getPrimaryService(COLMI_SERVICE_UUID);
      this.txChar = await service.getCharacteristic(COLMI_TX_UUID);
      this.rxChar = await service.getCharacteristic(COLMI_RX_UUID);

      // Add listener BEFORE startNotifications to avoid missing early data
      this.txChar.addEventListener(
        "characteristicvaluechanged",
        this.handleNotification.bind(this)
      );
      await this.txChar.startNotifications();

      // Wait for CCCD write to complete (Chrome race condition fix)
      await new Promise((r) => setTimeout(r, 200));

      // Check battery first
      await this.rxChar.writeValueWithResponse(buildBatteryCommand());

      // Send START real-time HR
      await this.rxChar.writeValueWithResponse(
        buildRealTimeCommand(RealTimeType.HEART_RATE, true)
      );

      this.setState("connected");

      // Send CONTINUE every 2s to keep HR measurement alive
      // (ring stops after ~10 readings if no CONTINUE received)
      setTimeout(() => {
        if (this.state === "connected") this.startPolling();
      }, 3000);
      return true;
    } catch (err) {
      console.error("Connect failed:", err);
      this.setState("disconnected");
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();

    try {
      if (this.rxChar) {
        await this.rxChar.writeValueWithResponse(
          buildRealTimeCommand(RealTimeType.HEART_RATE, false)
        );
      }
    } catch {
      // Ignore errors during cleanup
    }

    if (this.server?.connected) {
      this.server.disconnect();
    }

    this.device = null;
    this.server = null;
    this.rxChar = null;
    this.txChar = null;
    this.data = {
      heartRate: null,
      spo2: null,
      accelX: null,
      accelY: null,
      accelZ: null,
      rawPpg: null,
      batteryLevel: null,
      isCharging: false,
      lastUpdate: 0,
    };
    this.setState("disconnected");
  }

  private handleNotification(event: Event) {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;

    // Debug: always log raw bytes
    const bytes = new Uint8Array(value.buffer);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`[Ring ${this.personId}] ${hex} | byte3=${bytes[3]}`);

    const parsed = parseNotification(value);
    if (!parsed) return;

    if (parsed.batteryLevel !== undefined) {
      this.data.batteryLevel = parsed.batteryLevel;
      this.data.isCharging = parsed.isCharging ?? false;
      console.log(`[Ring ${this.personId}] Battery: ${parsed.batteryLevel}%${parsed.isCharging ? ' (charging)' : ''}`);
    }
    if (parsed.heartRate !== undefined) this.data.heartRate = parsed.heartRate;
    if (parsed.spo2 !== undefined) this.data.spo2 = parsed.spo2;
    if (parsed.accelX !== undefined) this.data.accelX = parsed.accelX;
    if (parsed.accelY !== undefined) this.data.accelY = parsed.accelY;
    if (parsed.accelZ !== undefined) this.data.accelZ = parsed.accelZ;
    if (parsed.rawPpg !== undefined) this.data.rawPpg = parsed.rawPpg;

    this.data.lastUpdate = Date.now();
    this.onData({ ...this.data });
  }

  private startPolling() {
    // Send CONTINUE command every 2s to keep HR measurement alive
    this.hrInterval = setInterval(async () => {
      if (!this.rxChar || this.state !== "connected") return;
      try {
        await this.rxChar.writeValueWithoutResponse(buildContinueHRCommand());
      } catch {
        // Ignore write errors during polling
      }
    }, 2000);
  }

  private stopPolling() {
    if (this.hrInterval) {
      clearInterval(this.hrInterval);
      this.hrInterval = null;
    }
  }
}
