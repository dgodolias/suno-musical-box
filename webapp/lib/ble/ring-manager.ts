/**
 * BLE Ring Manager — scan, connect, disconnect.
 * Uses Web Bluetooth API (Chrome/Edge only).
 */

import {
  COLMI_SERVICE_UUID,
  COLMI_TX_UUID,
  COLMI_RX_UUID,
  buildRealTimeCommand,
  RealTimeType,
  parseNotification,
} from "./colmi-protocol";
import { SignalProcessor, type ProcessedMetrics } from "./signal-processor";

export type ConnectionState = "disconnected" | "scanning" | "connecting" | "connected";

export interface RingData {
  heartRate: number | null;
  heartRateRaw: number | null;
  spo2: number | null;
  hrv: number | null;
  accelX: number | null;
  accelY: number | null;
  accelZ: number | null;
  rawPpg: number | null;
  signalQuality: "good" | "weak" | "none";
  lastUpdate: number;
}

export class RingConnection {
  device: BluetoothDevice | null = null;
  server: BluetoothRemoteGATTServer | null = null;
  rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  txChar: BluetoothRemoteGATTCharacteristic | null = null;
  state: ConnectionState = "disconnected";
  processor = new SignalProcessor();
  data: RingData = {
    heartRate: null,
    heartRateRaw: null,
    spo2: null,
    hrv: null,
    accelX: null,
    accelY: null,
    accelZ: null,
    rawPpg: null,
    signalQuality: "none",
    lastUpdate: 0,
  };
  personId: 1 | 2;
  onStateChange: (state: ConnectionState) => void = () => {};
  onData: (data: RingData) => void = () => {};

  private hrInterval: ReturnType<typeof setInterval> | null = null;
  private emitInterval: ReturnType<typeof setInterval> | null = null;

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
        optionalServices: [COLMI_SERVICE_UUID],
      });

      if (!this.device) {
        this.setState("disconnected");
        return false;
      }

      this.device.addEventListener("gattserverdisconnected", () => {
        this.setState("disconnected");
        this.stopAll();
      });

      return await this.connect();
    } catch {
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

      await this.txChar.startNotifications();
      this.txChar.addEventListener(
        "characteristicvaluechanged",
        this.handleNotification.bind(this)
      );

      // Start real-time HR measurement
      await this.rxChar.writeValue(
        buildRealTimeCommand(RealTimeType.HEART_RATE, true)
      );

      this.processor.reset();
      this.setState("connected");

      // After 10s warmup, also request SpO2
      setTimeout(async () => {
        if (this.state !== "connected" || !this.rxChar) return;
        try {
          await this.rxChar.writeValue(
            buildRealTimeCommand(RealTimeType.SPO2, true)
          );
        } catch { /* ignore */ }
      }, 10000);

      // Re-send HR START every 30s to keep measurement alive
      this.startPolling();

      // Emit processed metrics every 1s (smoothed, with HRV)
      this.startEmitting();

      return true;
    } catch (err) {
      console.error("Connect failed:", err);
      this.setState("disconnected");
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.stopAll();

    try {
      if (this.rxChar) {
        await this.rxChar.writeValue(
          buildRealTimeCommand(RealTimeType.HEART_RATE, false)
        );
      }
    } catch { /* ignore */ }

    if (this.server?.connected) {
      this.server.disconnect();
    }

    this.processor.reset();
    this.device = null;
    this.server = null;
    this.rxChar = null;
    this.txChar = null;
    this.data = {
      heartRate: null,
      heartRateRaw: null,
      spo2: null,
      hrv: null,
      accelX: null,
      accelY: null,
      accelZ: null,
      rawPpg: null,
      signalQuality: "none",
      lastUpdate: 0,
    };
    this.setState("disconnected");
  }

  private handleNotification(event: Event) {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;

    const parsed = parseNotification(value);
    if (!parsed) return;

    // Feed raw values into signal processor
    if (parsed.heartRate !== undefined) {
      this.processor.addHeartRate(parsed.heartRate);
    }
    if (parsed.spo2 !== undefined) {
      this.processor.addSpo2(parsed.spo2);
    }
    if (parsed.rawPpg !== undefined) {
      this.processor.addRawPpg(parsed.rawPpg);
    }
  }

  private startEmitting() {
    // Every 1s: get smoothed metrics and emit to UI
    this.emitInterval = setInterval(() => {
      if (this.state !== "connected") return;

      const processed = this.processor.getProcessed();
      this.data = {
        heartRate: processed.heartRate,
        heartRateRaw: processed.heartRateRaw,
        spo2: processed.spo2,
        hrv: processed.hrv,
        accelX: null,
        accelY: null,
        accelZ: null,
        rawPpg: processed.rawPpg,
        signalQuality: processed.signalQuality,
        lastUpdate: Date.now(),
      };
      this.onData({ ...this.data });
    }, 1000);
  }

  private startPolling() {
    this.hrInterval = setInterval(async () => {
      if (!this.rxChar || this.state !== "connected") return;
      try {
        await this.rxChar.writeValue(buildRealTimeCommand(RealTimeType.HEART_RATE, true));
      } catch { /* ignore */ }
    }, 30000);
  }

  private stopAll() {
    if (this.hrInterval) {
      clearInterval(this.hrInterval);
      this.hrInterval = null;
    }
    if (this.emitInterval) {
      clearInterval(this.emitInterval);
      this.emitInterval = null;
    }
  }
}
