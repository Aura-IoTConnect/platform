import { PrismaClient, type RuleOperator, type AlertSeverity } from "@prisma/client";
import { hashPassword } from "../src/auth.js";

const prisma = new PrismaClient();

interface MetricDef {
  key: string;
  label: string;
  unit: string;
  min?: number;
  max?: number;
  // Optional ingest-time policy — see apps/workers/app/metric_pipeline.py.
  transform?: { type: "linear"; factor?: number; offset?: number };
  onOutOfRange?: "pass" | "clamp" | "reject";
  loggingMode?: "always" | "on-change";
  deadband?: number;
}

interface RuleDef {
  name: string;
  metric: string;
  operator: RuleOperator;
  threshold: number;
  severity: AlertSeverity;
  actionType: "notify" | "webhook" | "actuator";
  actionConfig?: Record<string, unknown>;
}

interface WidgetDef {
  type: "line-chart" | "gauge" | "stat-tile" | "alarm-table" | "svg-mimic";
  metricKey?: string;
  label?: string;
  // "svg-mimic" only — see apps/web/src/widgets/SvgMimicWidget.tsx
  svg?: string;
  bindings?: {
    elementId: string;
    metricKey: string;
    mode: "text" | "fill" | "visibility";
    thresholds?: { upTo?: number; color: string }[];
  }[];
}

// A minimal synoptic screen for the cold-storage unit: chamber body whose
// fill tracks temperature, a live readout, and a door indicator that only
// shows while door_open > 0. Authored by hand here; real deployments would
// paste an Inkscape export. Everything is plain SVG — no scripts.
const COLD_STORAGE_MIMIC = `<svg viewBox="0 0 320 120" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">
  <rect id="chamber" x="20" y="20" width="180" height="80" rx="8" fill="#3b82f6" stroke="#94a3b8" stroke-width="2"/>
  <text x="110" y="52" text-anchor="middle" fill="#fff" font-size="12">Chamber</text>
  <text id="temp-readout" x="110" y="76" text-anchor="middle" fill="#fff" font-size="18" font-weight="600">—</text>
  <rect x="200" y="30" width="10" height="60" fill="#94a3b8"/>
  <g id="door-open" visibility="hidden">
    <rect x="210" y="30" width="10" height="60" fill="#f59e0b" transform="rotate(-25 210 30)"/>
    <text x="250" y="66" fill="#f59e0b" font-size="12">DOOR OPEN</text>
  </g>
  <text id="humidity-readout" x="250" y="100" fill="#94a3b8" font-size="11">—</text>
</svg>`;

interface DeviceTypeDef {
  key: string;
  name: string;
  description: string;
  metrics: MetricDef[];
  rules: RuleDef[];
  sampleDevices: { name: string; location: string }[];
  // Optional — which dashboard widgets to render for this device type, and
  // in what order (see apps/web/src/widgets/). Omitted device types fall
  // back to one line chart per metric.
  defaultWidgets?: WidgetDef[];
}

interface VerticalDef {
  key: string;
  name: string;
  description: string;
  deviceTypes: DeviceTypeDef[];
}

const verticals: VerticalDef[] = [
  {
    key: "agri-processing",
    name: "Agri-Processing",
    description: "Post-harvest processing lines: drying, milling, grading, packaging.",
    deviceTypes: [
      {
        key: "grain-dryer",
        name: "Grain Dryer",
        description: "Monitors grain moisture and drying airflow temperature.",
        metrics: [
          // Working example of the ingest-time metric pipeline (see
          // apps/workers/app/metric_pipeline.py): a moisture probe can't
          // physically read outside 0-100%, so clamp glitches instead of
          // alerting on them, and only store history when it actually moves.
          {
            key: "grain_moisture",
            label: "Grain Moisture",
            unit: "%",
            min: 0,
            max: 100,
            onOutOfRange: "clamp",
            loggingMode: "on-change",
            deadband: 0.5,
          },
          { key: "air_temp", label: "Drying Air Temperature", unit: "°C", min: -10, max: 120 },
        ],
        rules: [
          {
            name: "Grain moisture too high for storage",
            metric: "grain_moisture",
            operator: "GT",
            threshold: 14,
            severity: "WARNING",
            actionType: "notify",
          },
          {
            name: "Drying air overheating",
            metric: "air_temp",
            operator: "GT",
            threshold: 60,
            severity: "CRITICAL",
            actionType: "actuator",
            actionConfig: { command: "reduce_burner_output" },
          },
        ],
        sampleDevices: [{ name: "Dryer Unit A", location: "Mill Site 1" }],
        defaultWidgets: [
          { type: "gauge", metricKey: "grain_moisture" },
          { type: "stat-tile", metricKey: "air_temp" },
          { type: "line-chart", metricKey: "air_temp" },
          { type: "alarm-table" },
        ],
      },
    ],
  },
  {
    key: "weather",
    name: "Weather Monitoring",
    description: "Environmental weather stations for agriculture, aviation, and public safety.",
    deviceTypes: [
      {
        key: "weather-station",
        name: "Weather Station",
        description: "Ambient weather sensor array.",
        metrics: [
          { key: "wind_speed", label: "Wind Speed", unit: "km/h", min: 0, max: 250 },
          { key: "rainfall", label: "Rainfall", unit: "mm/h", min: 0, max: 200 },
          { key: "temperature", label: "Air Temperature", unit: "°C", min: -40, max: 55 },
        ],
        rules: [
          {
            name: "High wind advisory",
            metric: "wind_speed",
            operator: "GT",
            threshold: 60,
            severity: "WARNING",
            actionType: "notify",
          },
          {
            name: "Severe storm rainfall rate",
            metric: "rainfall",
            operator: "GT",
            threshold: 50,
            severity: "CRITICAL",
            actionType: "webhook",
            actionConfig: { url: "https://example.org/hooks/weather-alert" },
          },
        ],
        sampleDevices: [{ name: "Station North Field", location: "Farm Perimeter N" }],
        defaultWidgets: [
          { type: "gauge", metricKey: "wind_speed" },
          { type: "stat-tile", metricKey: "temperature" },
          { type: "line-chart", metricKey: "rainfall" },
          { type: "alarm-table" },
        ],
      },
    ],
  },
  {
    key: "cold-storage",
    name: "Cold Storage",
    description: "Refrigerated warehousing and cold chain monitoring.",
    deviceTypes: [
      {
        key: "cold-storage-unit",
        name: "Cold Storage Unit",
        description: "Walk-in freezer/chiller with compressor telemetry.",
        metrics: [
          { key: "temperature", label: "Chamber Temperature", unit: "°C", min: -30, max: 15 },
          { key: "humidity", label: "Humidity", unit: "%", min: 0, max: 100 },
          { key: "door_open", label: "Door Open", unit: "bool", min: 0, max: 1 },
        ],
        rules: [
          {
            name: "Freeze alarm: temperature breach",
            metric: "temperature",
            operator: "GT",
            threshold: -12,
            severity: "CRITICAL",
            actionType: "actuator",
            actionConfig: { command: "increase_compressor_duty" },
          },
          {
            name: "Door left open",
            metric: "door_open",
            operator: "EQ",
            threshold: 1,
            severity: "WARNING",
            actionType: "notify",
          },
        ],
        sampleDevices: [{ name: "Chiller Bay 3", location: "Distribution Center West" }],
        defaultWidgets: [
          {
            type: "svg-mimic",
            label: "Chiller mimic",
            svg: COLD_STORAGE_MIMIC,
            bindings: [
              { elementId: "temp-readout", metricKey: "temperature", mode: "text" },
              {
                elementId: "chamber",
                metricKey: "temperature",
                mode: "fill",
                // freeze-alarm rule fires above -12 °C
                thresholds: [
                  { upTo: -18, color: "#2563eb" },
                  { upTo: -12, color: "#3b82f6" },
                  { color: "#ef4444" },
                ],
              },
              { elementId: "door-open", metricKey: "door_open", mode: "visibility" },
              { elementId: "humidity-readout", metricKey: "humidity", mode: "text" },
            ],
          },
          { type: "gauge", metricKey: "temperature" },
          { type: "stat-tile", metricKey: "humidity" },
          { type: "line-chart", metricKey: "temperature" },
          { type: "alarm-table" },
        ],
      },
    ],
  },
  {
    key: "smart-home-office",
    name: "Smart Home / Office",
    description: "Residential and commercial building automation and comfort control.",
    deviceTypes: [
      {
        key: "hvac-zone",
        name: "HVAC Zone Controller",
        description: "Per-zone climate control and occupancy sensing.",
        metrics: [
          { key: "temperature", label: "Room Temperature", unit: "°C", min: -10, max: 45 },
          { key: "co2", label: "CO2", unit: "ppm", min: 300, max: 5000 },
          { key: "occupancy", label: "Occupancy", unit: "count", min: 0, max: 200 },
        ],
        rules: [
          {
            name: "Poor air quality",
            metric: "co2",
            operator: "GT",
            threshold: 1200,
            severity: "WARNING",
            actionType: "actuator",
            actionConfig: { command: "increase_fresh_air_intake" },
          },
        ],
        sampleDevices: [{ name: "Zone 2 - Open Office", location: "HQ Floor 4" }],
      },
    ],
  },
  {
    key: "warehousing",
    name: "Warehousing & Logistics",
    description: "Warehouse environment, racking, and material handling equipment.",
    deviceTypes: [
      {
        key: "forklift",
        name: "Forklift",
        description: "Material handling vehicle telemetry.",
        metrics: [
          { key: "battery_level", label: "Battery Level", unit: "%", min: 0, max: 100 },
          { key: "load_weight", label: "Load Weight", unit: "kg", min: 0, max: 5000 },
          { key: "engine_hours", label: "Engine Hours", unit: "h", min: 0 },
        ],
        rules: [
          {
            name: "Overload risk",
            metric: "load_weight",
            operator: "GT",
            threshold: 4500,
            severity: "CRITICAL",
            actionType: "notify",
          },
          {
            name: "Battery critically low",
            metric: "battery_level",
            operator: "LT",
            threshold: 15,
            severity: "WARNING",
            actionType: "notify",
          },
        ],
        sampleDevices: [{ name: "Forklift 12", location: "Warehouse B Aisle 4" }],
      },
    ],
  },
  {
    key: "e-health",
    name: "e-Health",
    description: "Remote patient monitoring and clinical asset tracking.",
    deviceTypes: [
      {
        key: "vitals-monitor",
        name: "Wearable Vitals Monitor",
        description: "Continuous patient vitals telemetry.",
        metrics: [
          { key: "heart_rate", label: "Heart Rate", unit: "bpm", min: 20, max: 220 },
          { key: "spo2", label: "Blood Oxygen", unit: "%", min: 50, max: 100 },
          { key: "body_temp", label: "Body Temperature", unit: "°C", min: 30, max: 43 },
        ],
        rules: [
          {
            name: "Low blood oxygen",
            metric: "spo2",
            operator: "LT",
            threshold: 92,
            severity: "CRITICAL",
            actionType: "notify",
          },
          {
            name: "Tachycardia",
            metric: "heart_rate",
            operator: "GT",
            threshold: 140,
            severity: "WARNING",
            actionType: "notify",
          },
        ],
        sampleDevices: [{ name: "Patient Monitor 08", location: "Ward 3 Bed 8" }],
      },
    ],
  },
  {
    key: "smart-metering",
    name: "Smart Metering",
    description: "Utility metering for electricity, water, and gas consumption.",
    deviceTypes: [
      {
        key: "smart-electric-meter",
        name: "Smart Electric Meter",
        description: "Residential/commercial electricity consumption meter.",
        metrics: [
          { key: "power_draw", label: "Power Draw", unit: "kW", min: 0, max: 100 },
          { key: "voltage", label: "Voltage", unit: "V", min: 180, max: 260 },
        ],
        rules: [
          {
            name: "Voltage out of safe range",
            metric: "voltage",
            operator: "GT",
            threshold: 250,
            severity: "CRITICAL",
            actionType: "actuator",
            actionConfig: { command: "trip_breaker" },
          },
          {
            name: "Unusual power draw spike",
            metric: "power_draw",
            operator: "GT",
            threshold: 20,
            severity: "WARNING",
            actionType: "notify",
          },
        ],
        sampleDevices: [{ name: "Meter 4471", location: "Residential Block C Unit 12" }],
      },
    ],
  },
  {
    key: "manufacturing",
    name: "Manufacturing",
    description: "Factory floor equipment health and production line monitoring.",
    deviceTypes: [
      {
        key: "cnc-machine",
        name: "CNC Machine",
        description: "Precision machining equipment with vibration and spindle telemetry.",
        metrics: [
          { key: "spindle_temp", label: "Spindle Temperature", unit: "°C", min: 0, max: 150 },
          { key: "vibration", label: "Vibration", unit: "mm/s", min: 0, max: 50 },
          { key: "cycle_count", label: "Cycle Count", unit: "count", min: 0 },
        ],
        rules: [
          {
            name: "Excessive vibration — possible tool wear",
            metric: "vibration",
            operator: "GT",
            threshold: 12,
            severity: "WARNING",
            actionType: "notify",
          },
          {
            name: "Spindle overheating",
            metric: "spindle_temp",
            operator: "GT",
            threshold: 90,
            severity: "CRITICAL",
            actionType: "actuator",
            actionConfig: { command: "pause_spindle" },
          },
        ],
        sampleDevices: [{ name: "CNC-07", location: "Plant 2 Line C" }],
      },
    ],
  },
  {
    key: "water-treatment",
    name: "Water Treatment",
    description: "Potable water and wastewater treatment process monitoring.",
    deviceTypes: [
      {
        key: "treatment-basin",
        name: "Treatment Basin Sensor",
        description: "Water quality sensor array for a treatment basin.",
        metrics: [
          { key: "ph", label: "pH", unit: "pH", min: 0, max: 14 },
          { key: "turbidity", label: "Turbidity", unit: "NTU", min: 0, max: 500 },
          { key: "chlorine", label: "Free Chlorine", unit: "mg/L", min: 0, max: 10 },
        ],
        rules: [
          {
            name: "pH out of safe range",
            metric: "ph",
            operator: "GT",
            threshold: 8.5,
            severity: "CRITICAL",
            actionType: "actuator",
            actionConfig: { command: "dose_acid" },
          },
          {
            name: "High turbidity",
            metric: "turbidity",
            operator: "GT",
            threshold: 5,
            severity: "WARNING",
            actionType: "notify",
          },
        ],
        sampleDevices: [{ name: "Basin 2 Sensor Array", location: "Treatment Plant East" }],
      },
    ],
  },
  {
    key: "mining",
    name: "Mining",
    description: "Underground and open-pit mining safety and equipment monitoring.",
    deviceTypes: [
      {
        key: "gas-detector",
        name: "Methane/Gas Detector",
        description: "Fixed underground atmospheric safety sensor.",
        metrics: [
          { key: "methane", label: "Methane Concentration", unit: "%LEL", min: 0, max: 100 },
          { key: "co", label: "Carbon Monoxide", unit: "ppm", min: 0, max: 1000 },
        ],
        rules: [
          {
            name: "Methane concentration hazard",
            metric: "methane",
            operator: "GT",
            threshold: 25,
            severity: "CRITICAL",
            actionType: "webhook",
            actionConfig: { url: "https://example.org/hooks/mine-evacuation" },
          },
        ],
        sampleDevices: [{ name: "Shaft 3 Gas Sensor", location: "Underground Level -240m" }],
      },
    ],
  },
  {
    key: "security",
    name: "Security & Surveillance",
    description: "Perimeter and access control sensing for physical security.",
    deviceTypes: [
      {
        key: "perimeter-sensor",
        name: "Perimeter Motion/Access Sensor",
        description: "Fence-line motion and access breach detection.",
        metrics: [
          { key: "motion_events", label: "Motion Events", unit: "count/min", min: 0, max: 100 },
          { key: "tamper", label: "Tamper Detected", unit: "bool", min: 0, max: 1 },
        ],
        rules: [
          {
            name: "Tamper detected",
            metric: "tamper",
            operator: "EQ",
            threshold: 1,
            severity: "CRITICAL",
            actionType: "webhook",
            actionConfig: { url: "https://example.org/hooks/security-dispatch" },
          },
        ],
        sampleDevices: [{ name: "Fence Sensor Gate 1", location: "Site Perimeter North" }],
      },
    ],
  },
  {
    key: "transportation",
    name: "Transportation & Fleet",
    description: "Vehicle fleet telematics and cold-chain transport monitoring.",
    deviceTypes: [
      {
        key: "fleet-tracker",
        name: "Fleet Vehicle Tracker",
        description: "Vehicle telematics unit.",
        metrics: [
          { key: "speed", label: "Speed", unit: "km/h", min: 0, max: 220 },
          { key: "fuel_level", label: "Fuel Level", unit: "%", min: 0, max: 100 },
          { key: "engine_temp", label: "Engine Temperature", unit: "°C", min: 0, max: 150 },
        ],
        rules: [
          {
            name: "Speeding",
            metric: "speed",
            operator: "GT",
            threshold: 120,
            severity: "WARNING",
            actionType: "notify",
          },
          {
            name: "Engine overheating",
            metric: "engine_temp",
            operator: "GT",
            threshold: 115,
            severity: "CRITICAL",
            actionType: "notify",
          },
        ],
        sampleDevices: [{ name: "Truck 21", location: "Route 4 — Regional Distribution" }],
      },
    ],
  },
  {
    key: "smart-city",
    name: "Smart City",
    description: "Municipal infrastructure: street lighting, traffic, waste management.",
    deviceTypes: [
      {
        key: "smart-streetlight",
        name: "Smart Streetlight",
        description: "Adaptive street lighting with ambient and fault sensing.",
        metrics: [
          { key: "ambient_light", label: "Ambient Light", unit: "lux", min: 0, max: 100000 },
          { key: "power_draw", label: "Power Draw", unit: "W", min: 0, max: 500 },
          { key: "fault", label: "Fault", unit: "bool", min: 0, max: 1 },
        ],
        rules: [
          {
            name: "Lamp fault detected",
            metric: "fault",
            operator: "EQ",
            threshold: 1,
            severity: "WARNING",
            actionType: "notify",
          },
        ],
        sampleDevices: [{ name: "Streetlight 118", location: "Main St & 5th Ave" }],
      },
      {
        key: "waste-bin",
        name: "Smart Waste Bin",
        description: "Fill-level sensing for municipal waste collection routing.",
        metrics: [{ key: "fill_level", label: "Fill Level", unit: "%", min: 0, max: 100 }],
        rules: [
          {
            name: "Bin nearly full",
            metric: "fill_level",
            operator: "GTE",
            threshold: 85,
            severity: "INFO",
            actionType: "notify",
          },
        ],
        sampleDevices: [{ name: "Bin 204", location: "Central Park Entrance" }],
      },
    ],
  },
  {
    key: "energy",
    name: "Energy & Solar",
    description: "Distributed generation, storage, and grid-edge monitoring.",
    deviceTypes: [
      {
        key: "solar-inverter",
        name: "Solar Inverter",
        description: "Grid-tied solar inverter telemetry.",
        metrics: [
          { key: "output_power", label: "Output Power", unit: "kW", min: 0, max: 500 },
          { key: "panel_temp", label: "Panel Temperature", unit: "°C", min: -20, max: 90 },
          { key: "efficiency", label: "Conversion Efficiency", unit: "%", min: 0, max: 100 },
        ],
        rules: [
          {
            name: "Panel overheating — efficiency risk",
            metric: "panel_temp",
            operator: "GT",
            threshold: 75,
            severity: "WARNING",
            actionType: "notify",
          },
          {
            name: "Output power fault (near zero during daylight)",
            metric: "output_power",
            operator: "LTE",
            threshold: 0,
            severity: "CRITICAL",
            actionType: "notify",
          },
        ],
        sampleDevices: [{ name: "Inverter Array 3", location: "Solar Farm Block D" }],
      },
    ],
  },
];

const agents = [
  {
    key: "anomaly-explainer",
    name: "Anomaly Explainer",
    description:
      "Given a telemetry breach and recent readings, explains the likely root cause in plain language for an operator.",
    systemPrompt: [
      "You are an industrial IoT reliability engineer assistant.",
      "You are given a device, its type, a breached rule, and a short window of recent telemetry readings.",
      "Explain concisely (2-4 sentences) what is likely happening and why it matters operationally.",
      "Then suggest one concrete next check or action.",
      "Respond as JSON: { \"explanation\": string, \"suggestedAction\": string, \"confidence\": \"low\"|\"medium\"|\"high\" }.",
    ].join(" "),
  },
  {
    key: "alert-triage",
    name: "Alert Triage",
    description:
      "Reviews a batch of open alerts across devices and ranks them by operational urgency.",
    systemPrompt: [
      "You are an alert triage assistant for an industrial operations center.",
      "You are given a list of open alerts (device, vertical, severity, message, age).",
      "Rank them by true urgency, considering severity, vertical (life-safety > equipment damage > efficiency), and age.",
      "Respond as JSON: { \"ranked\": [{ \"alertId\": string, \"priority\": number, \"reason\": string }] }.",
    ].join(" "),
  },
  {
    key: "automation-suggester",
    name: "Automation Suggester",
    description:
      "Looks at a device type's rules and recent alert history to propose new or adjusted automation rules.",
    systemPrompt: [
      "You are an automation engineer assistant for an IoT platform.",
      "You are given a device type, its current rules, and a summary of recent alerts it has triggered.",
      "Propose at most 2 new or adjusted rules (threshold tuning or new conditions) that would reduce noise or catch issues earlier.",
      "Respond as JSON: { \"suggestions\": [{ \"metric\": string, \"operator\": string, \"threshold\": number, \"severity\": string, \"rationale\": string }] }.",
    ].join(" "),
  },
];

async function main() {
  for (const vertical of verticals) {
    const createdVertical = await prisma.vertical.upsert({
      where: { key: vertical.key },
      update: { name: vertical.name, description: vertical.description },
      create: {
        key: vertical.key,
        name: vertical.name,
        description: vertical.description,
      },
    });

    for (const deviceType of vertical.deviceTypes) {
      const createdDeviceType = await prisma.deviceType.upsert({
        where: { verticalId_key: { verticalId: createdVertical.id, key: deviceType.key } },
        update: {
          name: deviceType.name,
          description: deviceType.description,
          metrics: deviceType.metrics,
          defaultWidgets: deviceType.defaultWidgets,
        },
        create: {
          verticalId: createdVertical.id,
          key: deviceType.key,
          name: deviceType.name,
          description: deviceType.description,
          metrics: deviceType.metrics,
          defaultWidgets: deviceType.defaultWidgets,
        },
      });

      for (const rule of deviceType.rules) {
        const existing = await prisma.rule.findFirst({
          where: { deviceTypeId: createdDeviceType.id, name: rule.name },
        });
        if (!existing) {
          await prisma.rule.create({
            data: {
              deviceTypeId: createdDeviceType.id,
              name: rule.name,
              metric: rule.metric,
              operator: rule.operator,
              threshold: rule.threshold,
              severity: rule.severity,
              actionType: rule.actionType,
              actionConfig: rule.actionConfig,
            },
          });
        }
      }

      for (const device of deviceType.sampleDevices) {
        const existing = await prisma.device.findFirst({
          where: { deviceTypeId: createdDeviceType.id, name: device.name },
        });
        if (!existing) {
          await prisma.device.create({
            data: {
              deviceTypeId: createdDeviceType.id,
              name: device.name,
              location: device.location,
            },
          });
        }
      }
    }
  }

  for (const agent of agents) {
    await prisma.agent.upsert({
      where: { key: agent.key },
      update: {
        name: agent.name,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
      },
      create: agent,
    });
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const passwordHash = await hashPassword(adminPassword);
    await prisma.user.upsert({
      where: { email: adminEmail },
      update: { passwordHash, role: "ADMIN" },
      create: { email: adminEmail, passwordHash, role: "ADMIN" },
    });
    console.log(`Upserted admin user ${adminEmail}.`);
  } else {
    console.log("ADMIN_EMAIL/ADMIN_PASSWORD not set — skipping admin user seed.");
  }

  console.log(
    `Seeded ${verticals.length} verticals, ${verticals.reduce((n, v) => n + v.deviceTypes.length, 0)} device types, and ${agents.length} agents.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
