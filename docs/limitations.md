# Limitations

## BLE / Colmi R02 Rings
- The rings need **30-40 seconds** after connection to start providing BPM readings. During this warmup period, the PPG sensor calibrates and byte[3] (HR value) stays at 0.
- Chrome/Edge can struggle with **2 simultaneous BLE connections**. The second ring may fail to connect — retry usually works.
- BLE connections **drop on page reload**. User must reconnect manually.
- The rings **auto-sleep** after inactivity and **die without warning** at low battery.
- **Only 1 metric at a time**: HR and SpO2 cannot run simultaneously (different LED modes: green=HR, red=SpO2). The ring's firmware allows only one measurement type per session.
- **Raw sensor streaming (0xA1)** for accelerometer/PPG can technically run alongside HR (0x69) but shares the same BLE TX channel — packets interleave and can corrupt each other.
- **Available real-time**: HR only. SpO2 requires separate measurement cycle. Accelerometer possible but unreliable alongside HR.

## Suno API
- Generation takes **1.5-2 minutes**. Not real-time.
- Each song costs ~ 0.07$

## Web App
- **Chrome/Edge only** — Firefox and Safari do not support Web Bluetooth.
