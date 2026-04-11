/**
 * BLE Ring Manager — scan, connect, disconnect.
 * Matches the colmi_r02_client Python implementation exactly.
 */

import {
  COLMI_SERVICE_UUID,
  COLMI_TX_UUID,
  COLMI_RX_UUID,
  buildRealTimeCommand,
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

  // Measurement restart timer (Python client does one-shot, we repeat)
  private measurementTimer: ReturnType<typeof setInterval> | null = null;

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
      alert("Web Bluetooth is not supported. Use Chrome or Edge.");
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
        this.stopMeasurement();
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

      // Subscribe to notifications (matching Python: subscribe first, then write)
      this.txChar.addEventListener(
        "characteristicvaluechanged",
        this.handleNotification.bind(this)
      );
      await this.txChar.startNotifications();

      this.setState("connected");

      // Don't start measurement immediately — let user connect both rings first
      // Measurement starts when user clicks "Start Session" or after 10s auto-start
      setTimeout(() => {
        if (this.state === "connected" && this.data.heartRate === null) {
          this.startMeasurement();
        }
      }, 10000);

      return true;
    } catch (err) {
      console.error("Connect failed:", err);
      this.setState("disconnected");
      return false;
    }
  }

  async beginMeasurement(): Promise<void> {
    return this.startMeasurement();
  }

  private async startMeasurement(): Promise<void> {
    if (!this.rxChar || this.state !== "connected") return;

    const startCmd = buildRealTimeCommand(RealTimeType.HEART_RATE, true);

    // Retry START up to 3 times with 1s delay between attempts
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[Ring ${this.personId}] START HR attempt ${attempt}/3...`);

        if (this.rxChar.properties.writeWithoutResponse) {
          await this.rxChar.writeValueWithoutResponse(startCmd);
        } else {
          await this.rxChar.writeValue(startCmd);
        }

        console.log(`[Ring ${this.personId}] START sent OK (attempt ${attempt})`);
        break;
      } catch (err) {
        console.error(`[Ring ${this.personId}] START failed attempt ${attempt}:`, err);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    // Restart measurement every 45s (in case ring stops streaming)
    if (!this.measurementTimer) {
      this.measurementTimer = setInterval(() => {
        this.startMeasurement();
      }, 45000);
    }
  }

  private stopMeasurement(): void {
    if (this.measurementTimer) {
      clearInterval(this.measurementTimer);
      this.measurementTimer = null;
    }
  }

  async disconnect(): Promise<void> {
    this.stopMeasurement();

    try {
      if (this.rxChar) {
        const stopCmd = buildRealTimeCommand(RealTimeType.HEART_RATE, false);
        if (this.rxChar.properties.writeWithoutResponse) {
          await this.rxChar.writeValueWithoutResponse(stopCmd);
        } else {
          await this.rxChar.writeValue(stopCmd);
        }
      }
    } catch { /* ignore */ }

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

    // Debug log
    const bytes = new Uint8Array(value.buffer);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const b3 = bytes[3];
    if (b3 > 0) {
      console.log(`[Ring ${this.personId}] ${hex} | byte3=${b3} *** HR DATA ***`);
    }

    const parsed = parseNotification(value);
    if (!parsed) return;

    if (parsed.batteryLevel !== undefined) {
      this.data.batteryLevel = parsed.batteryLevel;
      this.data.isCharging = parsed.isCharging ?? false;
      console.log(`[Ring ${this.personId}] Battery: ${parsed.batteryLevel}%`);
    }
    if (parsed.heartRate !== undefined) {
      this.data.heartRate = parsed.heartRate;
      console.log(`[Ring ${this.personId}] HR: ${parsed.heartRate} BPM`);
    }
    if (parsed.spo2 !== undefined) this.data.spo2 = parsed.spo2;
    if (parsed.rawPpg !== undefined) this.data.rawPpg = parsed.rawPpg;

    this.data.lastUpdate = Date.now();
    this.onData({ ...this.data });
  }
}
