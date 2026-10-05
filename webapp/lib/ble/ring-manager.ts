import {
  buildBatteryCommand,
  buildContinueHRCommand,
  buildHeartRateStartCommand,
  buildStopCommand,
  COLMI_RX_UUID,
  COLMI_SERVICE_UUID,
  COLMI_TX_UUID,
  parseNotification,
  RealTimeType,
} from "./colmi-protocol";
import type { HeartRateMode } from "./colmi-protocol";

export type { HeartRateMode } from "./colmi-protocol";

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

export interface RingDiagnostics {
  measurementState: "idle" | "warming-up" | "measuring" | "stale" | "waiting-for-contact" | "error";
  packetsReceived: number;
  heartRateSamples: number;
  lastHeartRateAt: number;
  lastPacketAt: number;
  startsSent: number;
  continuesSent: number;
  restartCount: number;
  lastError: string | null;
  firmware: string | null;
  hardware: string | null;
}

interface DebugEvent {
  at: string;
  direction: "sent" | "received" | "event";
  detail: string;
}

const WATCHDOG_INTERVAL_MS = 2_000;
const CONTINUE_GAP_MS = 10_000;
export const HR_STALE_MS = 15_000;
const WARMUP_TIMEOUT_MS = 60_000;
const STALL_RECOVERY_MS = 45_000;
const MAX_AUTOMATIC_RECOVERIES = 2;
const DEBUG_EVENT_LIMIT = 200;
const MODE_SWITCH_QUIET_MS = 2_000;
const DISCONNECT_TIMEOUT_MS = 3_000;
const REALTIME_CAPTURE_TIMEOUT_MS = 90_000;
const CONTACT_RETRY_MS = 3_000;
const VERIFIED_REALTIME_PROFILES = [
  { firmware: "RT02R_3.11.00_250611", hardware: "RT02R_V3.1" },
  { firmware: "R02_3.00.17_240903", hardware: "R02_V3.0" },
] as const;

function emptyData(): RingData {
  return { heartRate: null, spo2: null, accelX: null, accelY: null, accelZ: null, rawPpg: null, batteryLevel: null, isCharging: false, lastUpdate: 0 };
}

function emptyDiagnostics(): RingDiagnostics {
  return { measurementState: "idle", packetsReceived: 0, heartRateSamples: 0, lastHeartRateAt: 0, lastPacketAt: 0, startsSent: 0, continuesSent: 0, restartCount: 0, lastError: null, firmware: null, hardware: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hex(data: DataView | ArrayBuffer): string {
  const bytes = data instanceof DataView
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

export class RingConnection {
  device: BluetoothDevice | null = null;
  server: BluetoothRemoteGATTServer | null = null;
  rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  txChar: BluetoothRemoteGATTCharacteristic | null = null;
  state: ConnectionState = "disconnected";
  data = emptyData();
  diagnostics = emptyDiagnostics();
  onStateChange: (state: ConnectionState) => void = () => {};
  onData: (data: RingData) => void = () => {};
  onHeartRate: (data: RingData) => void = () => {};
  onDiagnostics: (diagnostics: RingDiagnostics) => void = () => {};

  private generation = 0;
  private measurementGeneration = 0;
  private measurementWanted = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private connecting: Promise<boolean> | null = null;
  private connectingGeneration = 0;
  private closing: Promise<void> | null = null;
  private continuePending = false;
  private recoveryPending = false;
  private automaticRecoveries = 0;
  private startedAt = 0;
  private lastMeasurementPacketAt = 0;
  private lastMeasurementHeartRateAt = 0;
  private lastContinueAt = 0;
  private continuationWarmupAt = 0;
  private contactRetryAt: number | null = null;
  private contactRecoveryActive = false;
  private debugEvents: DebugEvent[] = [];
  private selectedHeartRateMode: HeartRateMode = "standard";
  private heartRateModeExplicit = false;
  private modeSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveModeSwitchDelay: (() => void) | null = null;

  constructor(public personId: 1 | 2) {}

  get name(): string {
    return this.device?.name || "Unknown";
  }

  get heartRateMode(): HeartRateMode {
    return this.selectedHeartRateMode;
  }

  private get measurementType(): RealTimeType {
    return this.selectedHeartRateMode === "realtime" ? RealTimeType.REAL_TIME_HEART_RATE : RealTimeType.HEART_RATE;
  }

  private emitDiagnostics() {
    this.onDiagnostics({ ...this.diagnostics });
  }

  private record(direction: DebugEvent["direction"], detail: string) {
    this.debugEvents.push({ at: new Date().toISOString(), direction, detail });
    if (this.debugEvents.length > DEBUG_EVENT_LIMIT) this.debugEvents.shift();
  }

  getDebugReport(): string {
    return JSON.stringify({
      generatedAt: new Date().toISOString(), personId: this.personId,
      deviceName: this.name, connectionState: this.state,
      heartRateMode: this.selectedHeartRateMode,
      mode: this.selectedHeartRateMode === "realtime"
        ? "Realtime heart rate (type 6), no CONTINUE"
        : `Heart rate (type 1), ${this.selectedHeartRateMode} START, one CONTINUE after silence with 60s recovery grace`,
      diagnostics: this.diagnostics, events: this.debugEvents,
    }, null, 2);
  }

  private setState(state: ConnectionState) {
    this.state = state;
    this.onStateChange(state);
  }

  private fail(message: string) {
    this.record("event", message);
    this.diagnostics.lastError = message;
    this.diagnostics.measurementState = "error";
    this.emitDiagnostics();
  }

  private resetData() {
    this.data = emptyData();
    this.onData({ ...this.data });
  }

  private clearLiveHeartRate() {
    this.data.heartRate = null;
    this.data.lastUpdate = Date.now();
    this.lastMeasurementHeartRateAt = 0;
    this.diagnostics.lastHeartRateAt = 0;
    this.onData({ ...this.data });
  }

  private stopWatchdog() {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    this.measurementWanted = false;
    this.measurementGeneration++;
    this.continuePending = false;
    this.recoveryPending = false;
    this.continuationWarmupAt = 0;
    this.contactRetryAt = null;
    this.contactRecoveryActive = false;
    if (this.modeSwitchTimer !== null) clearTimeout(this.modeSwitchTimer);
    this.modeSwitchTimer = null;
    const resolveDelay = this.resolveModeSwitchDelay;
    this.resolveModeSwitchDelay = null;
    resolveDelay?.();
  }

  private detachListeners() {
    this.txChar?.removeEventListener("characteristicvaluechanged", this.handleNotification);
    this.device?.removeEventListener("gattserverdisconnected", this.handleDisconnected);
  }

  private handleDisconnected = () => {
    this.generation++;
    this.stopWatchdog();
    this.detachListeners();
    this.server = null;
    this.rxChar = null;
    this.txChar = null;
    this.resetData();
    this.setState("disconnected");
    this.fail("Bluetooth connection lost. Reconnect the ring to resume measurements.");
  };

  async scan(): Promise<boolean> {
    if (this.closing || this.state === "scanning" || this.state === "connecting") return false;
    if (this.state === "connected") return true;
    if (!navigator.bluetooth) {
      this.fail("Web Bluetooth is not supported. Use Chrome or Edge.");
      return false;
    }
    const generation = ++this.generation;
    this.diagnostics.lastError = null;
    this.diagnostics.measurementState = "idle";
    this.emitDiagnostics();
    this.setState("scanning");
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [COLMI_SERVICE_UUID] }, { namePrefix: "R02" }, { namePrefix: "COLMI" }, { namePrefix: "R06" }, { namePrefix: "R09" }],
        optionalServices: [COLMI_SERVICE_UUID, "device_information"],
      });
      if (generation !== this.generation) return false;
      this.device = device;
      return await this.connect();
    } catch (error) {
      if (generation !== this.generation) return false;
      this.setState("disconnected");
      this.fail(`Device selection failed: ${errorMessage(error)}`);
      return false;
    }
  }

  connect(): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    if (this.state === "connected") return Promise.resolve(true);
    if (this.connecting && this.connectingGeneration === this.generation) return this.connecting;
    const previous = this.connecting;
    const generation = this.generation;
    // Drain a cancelled connect before reusing its GATT server. Its late cleanup
    // must finish before a newer connection can become active on the same device.
    if (previous) this.setState("connecting");
    const operation = previous
      ? previous.then(() => generation === this.generation && !this.closing ? this.connectDevice() : false)
      : this.connectDevice();
    this.connecting = operation;
    this.connectingGeneration = this.generation;
    void operation.finally(() => { if (this.connecting === operation) this.connecting = null; });
    return operation;
  }

  private async connectDevice(): Promise<boolean> {
    const device = this.device;
    if (!device?.gatt) return false;
    const generation = ++this.generation;
    this.connectingGeneration = generation;
    this.stopWatchdog();
    this.detachListeners();
    this.resetData();
    this.diagnostics = emptyDiagnostics();
    this.emitDiagnostics();
    this.setState("connecting");
    device.addEventListener("gattserverdisconnected", this.handleDisconnected);
    try {
      const server = await device.gatt.connect();
      if (generation !== this.generation) { server.disconnect(); return false; }
      this.server = server;
      const service = await server.getPrimaryService(COLMI_SERVICE_UUID);
      if (generation !== this.generation) return false;
      const txChar = await service.getCharacteristic(COLMI_TX_UUID);
      if (generation !== this.generation) return false;
      const rxChar = await service.getCharacteristic(COLMI_RX_UUID);
      if (generation !== this.generation) return false;
      this.txChar = txChar;
      this.rxChar = rxChar;
      txChar.addEventListener("characteristicvaluechanged", this.handleNotification);
      await txChar.startNotifications();
      if (generation !== this.generation) return false;
      await this.readDeviceInfo(server, generation);
      if (generation !== this.generation) return false;
      this.selectVerifiedMeasurementMode();
      this.setState("connected");
      this.record("event", "Connected; notifications ready");
      await this.write(buildBatteryCommand(), "BATTERY", generation);
      if (generation !== this.generation) return false;
      await this.beginMeasurement();
      return generation === this.generation && this.state === "connected";
    } catch (error) {
      if (generation !== this.generation) return false;
      this.stopWatchdog();
      this.detachListeners();
      this.server?.disconnect();
      this.server = null;
      this.rxChar = null;
      this.txChar = null;
      this.setState("disconnected");
      this.fail(`Connection failed: ${errorMessage(error)}`);
      return false;
    }
  }

  private async readDeviceInfo(server: BluetoothRemoteGATTServer, generation: number) {
    try {
      const service = await server.getPrimaryService("device_information");
      for (const [field, uuid] of [["firmware", "firmware_revision_string"], ["hardware", "hardware_revision_string"]] as const) {
        if (generation !== this.generation) return;
        try {
          const characteristic = await service.getCharacteristic(uuid);
          if (generation !== this.generation) return;
          const value = await characteristic.readValue();
          if (generation !== this.generation) return;
          this.diagnostics[field] = new TextDecoder().decode(value).replace(/\0/g, "").trim() || null;
        } catch (error) {
          if (generation === this.generation) this.record("event", `Optional ${field} unavailable: ${errorMessage(error)}`);
        }
      }
      this.emitDiagnostics();
    } catch (error) {
      if (generation === this.generation) this.record("event", `Optional device information unavailable: ${errorMessage(error)}`);
    }
  }

  private hasVerifiedRealtimeProfile(): boolean {
    return VERIFIED_REALTIME_PROFILES.some((profile) =>
      profile.firmware === this.diagnostics.firmware && profile.hardware === this.diagnostics.hardware);
  }

  private selectVerifiedMeasurementMode() {
    if (this.heartRateModeExplicit) return;
    const verified = this.hasVerifiedRealtimeProfile();
    this.selectedHeartRateMode = verified ? "realtime" : "standard";
    this.record("event", verified
      ? "Selected realtime heart rate for a hardware/firmware pair verified with captured measurements"
      : "Selected standard heart rate for an unverified hardware/firmware pair");
    this.emitDiagnostics();
  }

  /** All writes share one queue, including battery, retries, and STOP. */
  private write(command: ArrayBuffer, label: string, generation: number, measurementGeneration?: number): Promise<boolean> {
    const characteristic = this.rxChar;
    const operation = this.writeQueue.then(async () => {
      if (generation !== this.generation || !characteristic || characteristic !== this.rxChar || !this.server?.connected) return false;
      if (measurementGeneration !== undefined && measurementGeneration !== this.measurementGeneration) return false;
      try {
        if (characteristic.properties.writeWithoutResponse) await characteristic.writeValueWithoutResponse(command);
        else await characteristic.writeValueWithResponse(command);
        if (generation !== this.generation) return false;
        this.record("sent", `${label}: ${hex(command)}`);
        if (label === "START") this.diagnostics.startsSent++;
        if (label === "CONTINUE") { this.diagnostics.continuesSent++; this.lastContinueAt = Date.now(); }
        this.emitDiagnostics();
        return true;
      } catch (error) {
        if (generation === this.generation) this.fail(`${label} failed: ${errorMessage(error)}`);
        return false;
      }
    });
    this.writeQueue = operation.then(() => {});
    return operation;
  }

  async beginMeasurement(): Promise<void> {
    if (this.measurementWanted || this.recoveryPending || this.closing || this.state !== "connected") return;
    this.measurementWanted = true;
    this.automaticRecoveries = 0;
    this.measurementGeneration++;
    await this.startMeasurement(false);
  }

  async retryMeasurement(): Promise<void> {
    if (this.closing || this.state !== "connected" || this.recoveryPending) return;
    this.measurementWanted = true;
    this.automaticRecoveries = 0;
    this.measurementGeneration++;
    this.continuePending = false;
    this.contactRetryAt = null;
    this.contactRecoveryActive = false;
    await this.startMeasurement(true);
  }

  async setHeartRateMode(mode: HeartRateMode): Promise<void> {
    if (mode !== "standard" && mode !== "legacy" && mode !== "realtime") throw new Error("Unsupported heart-rate mode");
    this.heartRateModeExplicit = true;
    if (mode === this.selectedHeartRateMode) return;
    const previousType = this.measurementType;
    this.selectedHeartRateMode = mode;
    this.record("event", `Heart-rate mode selected: ${mode}`);
    if (this.closing || this.state !== "connected") { this.emitDiagnostics(); return; }

    this.stopWatchdog();
    const generation = this.generation;
    const measurementGeneration = this.measurementGeneration;
    this.automaticRecoveries = 0;
    this.recoveryPending = true;
    this.clearLiveHeartRate();
    this.diagnostics.measurementState = "warming-up";
    this.diagnostics.lastError = null;
    this.emitDiagnostics();
    const stopped = await this.write(buildStopCommand(previousType), "STOP", generation, measurementGeneration);
    if (generation !== this.generation || measurementGeneration !== this.measurementGeneration) return;
    if (!stopped) { this.recoveryPending = false; return; }
    await new Promise<void>((resolve) => {
      this.resolveModeSwitchDelay = resolve;
      this.modeSwitchTimer = setTimeout(() => {
        this.modeSwitchTimer = null;
        this.resolveModeSwitchDelay = null;
        resolve();
      }, MODE_SWITCH_QUIET_MS);
    });
    if (generation !== this.generation || measurementGeneration !== this.measurementGeneration || this.closing || this.state !== "connected") return;
    this.measurementWanted = true;
    await this.startMeasurement(true, false);
  }

  private async startMeasurement(restart: boolean, stopFirst = restart) {
    const generation = this.generation;
    const measurementGeneration = this.measurementGeneration;
    this.recoveryPending = true;
    this.startedAt = Date.now();
    this.lastMeasurementHeartRateAt = 0;
    this.lastMeasurementPacketAt = 0;
    this.lastContinueAt = 0;
    this.continuationWarmupAt = 0;
    this.clearLiveHeartRate();
    this.diagnostics.measurementState = this.contactRecoveryActive ? "waiting-for-contact" : "warming-up";
    this.diagnostics.lastError = null;
    this.emitDiagnostics();
    if (stopFirst && this.contactRecoveryActive) {
      const stopped = await this.stopWithTimeout(generation, measurementGeneration);
      if (generation !== this.generation || measurementGeneration !== this.measurementGeneration) return;
      if (stopped !== "sent") {
        this.stopWatchdog();
        this.closeGatt();
        this.resetData();
        this.setState("disconnected");
        this.fail("Contact recovery STOP did not complete. Reconnect the ring to resume measurements.");
        return;
      }
    } else if (stopFirst) {
      await this.write(buildStopCommand(this.measurementType), "STOP", generation, measurementGeneration);
    }
    const sent = await this.write(buildHeartRateStartCommand(this.selectedHeartRateMode), "START", generation, measurementGeneration);
    if (generation !== this.generation || measurementGeneration !== this.measurementGeneration || !this.measurementWanted) return;
    if (sent && restart) this.diagnostics.restartCount++;
    this.recoveryPending = false;
    if (this.watchdog === null) this.watchdog = setInterval(() => this.checkStream(), WATCHDOG_INTERVAL_MS);
    this.emitDiagnostics();
  }

  private async continueMeasurement() {
    if (this.selectedHeartRateMode === "realtime" || !this.measurementWanted || this.continuePending || this.recoveryPending || this.closing) return;
    this.continuePending = true;
    const generation = this.generation;
    const measurementGeneration = this.measurementGeneration;
    // Back off failed attempts too; a rejected GATT write must not retry on
    // every watchdog tick. A successful write refreshes this timestamp again.
    this.lastContinueAt = Date.now();
    const samplesBefore = this.diagnostics.heartRateSamples;
    const sent = await this.write(buildContinueHRCommand(), "CONTINUE", generation, measurementGeneration);
    if (generation === this.generation && measurementGeneration === this.measurementGeneration) {
      this.continuePending = false;
      // Both tested firmwares can restart optical warmup on CONTINUE. Give a
      // successful command a full warmup period instead of sending it again.
      // A fresh sample received during the write has already resumed the stream.
      if (sent && this.diagnostics.heartRateSamples === samplesBefore) {
        this.continuationWarmupAt = Date.now();
        this.diagnostics.measurementState = "warming-up";
        this.emitDiagnostics();
      }
    }
  }

  private checkStream() {
    if (!this.measurementWanted || this.state !== "connected" || this.recoveryPending || this.closing) return;
    const now = Date.now();
    if (this.contactRetryAt !== null) {
      if (now >= this.contactRetryAt) {
        this.contactRetryAt = null;
        this.measurementGeneration++;
        this.record("event", "Retrying realtime measurement after contact wait");
        void this.startMeasurement(true);
      }
      return;
    }
    if (this.continuationWarmupAt && now - this.continuationWarmupAt < WARMUP_TIMEOUT_MS) return;
    const sinceSample = now - (this.lastMeasurementHeartRateAt || this.startedAt);
    const timeout = this.selectedHeartRateMode === "realtime"
      ? REALTIME_CAPTURE_TIMEOUT_MS
      : this.lastMeasurementHeartRateAt ? STALL_RECOVERY_MS : WARMUP_TIMEOUT_MS;
    if (sinceSample >= timeout) {
      if (this.selectedHeartRateMode === "realtime") {
        if (this.hasVerifiedRealtimeProfile()) this.waitForContact("No fresh realtime heart rate for 90 seconds");
        else void this.finishRealtimeCapture();
        return;
      }
      if (this.automaticRecoveries >= MAX_AUTOMATIC_RECOVERIES) {
        this.stopWatchdog();
        this.fail("No fresh heart-rate samples after recovery attempts. Check ring contact, then retry measurement.");
        void this.write(buildStopCommand(this.measurementType), "STOP", this.generation, this.measurementGeneration);
        return;
      }
      this.automaticRecoveries++;
      this.measurementGeneration++;
      this.continuePending = false;
      this.record("event", `Recovering stalled measurement (${this.automaticRecoveries}/${MAX_AUTOMATIC_RECOVERIES})`);
      void this.startMeasurement(true);
      return;
    }
    if (this.lastMeasurementHeartRateAt && sinceSample >= HR_STALE_MS && this.diagnostics.measurementState !== "error") {
      this.diagnostics.measurementState = "stale";
      this.emitDiagnostics();
    }
    const sincePacket = now - (this.lastMeasurementPacketAt || this.startedAt);
    // Hardware can restart optical warmup on CONTINUE. Never interrupt startup
    // or an active stream merely because a fixed sample count has been reached.
    if (this.selectedHeartRateMode !== "realtime" && this.lastMeasurementHeartRateAt && sincePacket >= CONTINUE_GAP_MS && now - this.lastContinueAt >= CONTINUE_GAP_MS) {
      void this.continueMeasurement();
    }
  }

  private waitForContact(reason: string) {
    // Removal produced codes 1 then 2 on the two verified profiles. Preserve
    // the first retry deadline: repeated error notifications must not postpone
    // it or generate repeated writes. Zero replies after START get 90s warmup.
    if (this.contactRetryAt !== null) { this.emitDiagnostics(); return; }
    this.stopWatchdog();
    this.measurementWanted = true;
    this.contactRecoveryActive = true;
    this.contactRetryAt = Date.now() + CONTACT_RETRY_MS;
    this.clearLiveHeartRate();
    this.diagnostics.measurementState = "waiting-for-contact";
    this.diagnostics.lastError = null;
    this.record("event", `${reason}; waiting for contact before retry`);
    this.emitDiagnostics();
    this.watchdog = setInterval(() => this.checkStream(), WATCHDOG_INTERVAL_MS);
  }

  disconnect(): Promise<void> {
    if (this.closing) return this.closing;
    const operation = this.disconnectDevice();
    this.closing = operation;
    void operation.finally(() => { if (this.closing === operation) this.closing = null; });
    return operation;
  }

  private async stopWithTimeout(generation: number, measurementGeneration?: number): Promise<"sent" | "failed" | "timed-out"> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const result = await Promise.race([
      this.write(buildStopCommand(this.measurementType), "STOP", generation, measurementGeneration)
        .then((sent) => sent ? "sent" as const : "failed" as const),
      new Promise<"timed-out">((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), DISCONNECT_TIMEOUT_MS);
      }),
    ]);
    if (timeout !== null) clearTimeout(timeout);
    return result;
  }

  private closeGatt() {
    this.generation++;
    this.detachListeners();
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.writeQueue = Promise.resolve();
    this.server = null;
    this.rxChar = null;
    this.txChar = null;
  }

  private async finishRealtimeCapture(message = "No realtime heart-rate sample for 90 seconds. Capture stopped; retry manually or choose another mode.") {
    this.stopWatchdog();
    const generation = this.generation;
    const measurementGeneration = this.measurementGeneration;
    this.clearLiveHeartRate();
    this.fail(message);
    const result = await this.stopWithTimeout(generation, measurementGeneration);
    if (generation !== this.generation || measurementGeneration !== this.measurementGeneration) return;
    if (result !== "sent") {
      this.closeGatt();
      this.resetData();
      this.setState("disconnected");
      this.fail(`${message} The GATT connection was closed because STOP did not complete.`);
    }
  }

  private async disconnectDevice() {
    const generation = ++this.generation;
    this.stopWatchdog();
    this.detachListeners();
    this.resetData();
    this.setState("disconnected");
    if (this.server?.connected && this.rxChar) {
      const result = await this.stopWithTimeout(generation);
      if (generation !== this.generation) return;
      if (result === "timed-out") {
        const message = "Bluetooth STOP timed out; closing the GATT connection.";
        this.record("event", message);
        this.diagnostics.lastError = message;
      }
    }
    if (generation !== this.generation) return;
    // A native write may never settle. Close its physical connection and detach
    // the old queue so reconnect can proceed; late completions fail this token.
    this.closeGatt();
    this.device = null;
    this.diagnostics.measurementState = "idle";
    this.emitDiagnostics();
    this.record("event", "Disconnected");
  }

  private handleNotification = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    if (target !== this.txChar || this.state !== "connected" || this.closing) return;
    const value = target.value;
    if (!value) return;
    const now = Date.now();
    this.record("received", hex(value));
    this.diagnostics.packetsReceived++;
    this.diagnostics.lastPacketAt = now;
    const parsed = parseNotification(value);
    if (!parsed) { this.emitDiagnostics(); return; }
    const isHeartRatePacket = parsed.command === 0x1e || (parsed.command === 0x69 &&
      (parsed.type === RealTimeType.HEART_RATE || parsed.type === RealTimeType.REAL_TIME_HEART_RATE));
    const isSelectedSource = this.selectedHeartRateMode === "realtime"
      ? parsed.command === 0x1e || (parsed.command === 0x69 && parsed.type === RealTimeType.REAL_TIME_HEART_RATE)
      : parsed.command === 0x69 && parsed.type === RealTimeType.HEART_RATE;
    // Keep all frames in the raw trace, but do not record trailing packets from
    // another mode as observations of the currently selected measurement.
    if (isHeartRatePacket && !isSelectedSource) { this.emitDiagnostics(); return; }
    if (parsed.status === "invalid" || parsed.status === "error") {
      const message = parsed.error || "Unrecognized measurement error";
      if (this.measurementWanted && isSelectedSource && this.selectedHeartRateMode === "realtime") {
        const contactError = parsed.status === "error" && parsed.command === 0x69 &&
          parsed.type === RealTimeType.REAL_TIME_HEART_RATE &&
          (parsed.errorCode === 1 || parsed.errorCode === 2) && this.hasVerifiedRealtimeProfile();
        if (contactError) this.waitForContact(message);
        else void this.finishRealtimeCapture(message);
      } else {
        this.fail(message);
      }
      return;
    }
    if (isSelectedSource && this.measurementWanted) {
      this.lastMeasurementPacketAt = now;
    }
    let changed = false;
    for (const field of ["heartRate", "spo2", "rawPpg", "accelX", "accelY", "accelZ", "batteryLevel"] as const) {
      if (field === "heartRate" && !this.measurementWanted) continue;
      if (parsed[field] !== undefined) { this.data[field] = parsed[field]; changed = true; }
    }
    if (parsed.isCharging !== undefined) this.data.isCharging = parsed.isCharging;
    if (parsed.heartRate !== undefined && this.measurementWanted) {
      this.contactRetryAt = null;
      this.contactRecoveryActive = false;
      this.continuationWarmupAt = 0;
      this.lastMeasurementHeartRateAt = now;
      this.automaticRecoveries = 0;
      this.diagnostics.lastHeartRateAt = now;
      this.diagnostics.heartRateSamples++;
      this.diagnostics.measurementState = "measuring";
      this.diagnostics.lastError = null;
    }
    if (changed) {
      this.data.lastUpdate = now;
      const snapshot = { ...this.data };
      this.onData(snapshot);
      if (parsed.heartRate !== undefined && this.measurementWanted) this.onHeartRate(snapshot);
    }
    this.emitDiagnostics();
  };
}
