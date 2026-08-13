/**
 * iBMS Backend - Express Server
 * ============================
 * 
 * Endpoints:
 * - /api/predict/soc - LSTM SOC prediction
 * - /api/predict/dte - Distance to Empty calculation
 * - /api/route/distance - Google Maps route distance
 * - /api/status - System status
 * - /api/feasibility - Route feasibility check
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { spawnSync } = require('child_process');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  PYTHON_EXE: process.env.PYTHON_EXE || 'C:/Users/asus/AppData/Local/Programs/Python/Python313/python.exe',
  ANALYTICS_SCRIPT: process.env.ANALYTICS_SCRIPT || path.join(__dirname, 'python', 'analytics_bridge.py'),
  GOOGLE_MAPS_KEY: process.env.GOOGLE_MAPS_KEY || 'YOUR_GOOGLE_MAPS_API_KEY',
  
  // Battery specs (LiFePO4)
  BATTERY: {
    nominal_capacity: 60,  // Ah
    nominal_voltage: 63.5, // V
    min_voltage: 40,       // V (10% SOC)
    max_voltage: 64,       // V (100% SOC)
  },
  
  // DTE calculation (Wh/km)
  CONSUMPTION: {
    ECO: 150,    // Wh/km in ECO mode
    SPORT: 250,  // Wh/km in SPORT mode
  },
  
  // AMSA Logic thresholds
  AMSA: {
    critical_distance: 20, // km - trigger ECO mode
    impossible_distance: 5, // km - trigger "Charge Required"
  }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function calculateDTE(current_soc, drive_mode = 'ECO', env = {}) {
  const {
    baseSoh = 100,
    ambientTempDeltaC = 0,
    avgSpeedKmh = 60,
    accelAggressionPct = 0,
    uphillGrade = 0,
    downhillGrade = 0,
    trafficJamRatio = 0
  } = env;

  const realSoh = Math.max(0, Math.min(100, baseSoh));
  const battery_capacity_wh = (CONFIG.BATTERY.nominal_capacity * CONFIG.BATTERY.nominal_voltage) * (realSoh / 100);
  const available_energy = (current_soc / 100) * battery_capacity_wh;
  
  const base_consumption = CONFIG.CONSUMPTION[drive_mode];
  
  // 1. Aerodynamic Drag (exponential with speed)
  const effectiveSpeed = avgSpeedKmh * (1 - (trafficJamRatio * 0.5));
  const aeroFactor = Math.max(0.5, (effectiveSpeed / 60.0) ** 2);
  
  // 2. Stop-and-Go Acceleration (Traffic dictates torque spikes)
  const stopAndGoPenalty = 1 + (trafficJamRatio * (0.3 + (accelAggressionPct / 100) * 0.4));
  const baseAccelPenalty = 1 + (accelAggressionPct / 100) * 0.15;
  const totalAccelPenalty = stopAndGoPenalty * baseAccelPenalty;
  
  // 3. Uphill Climbing (massive power drain)
  const uphillPenalty = 1 + (uphillGrade * 0.15);
  
  // 4. Downhill Regenerative Braking (recharges battery)
  const regenEfficiency = 0.6 + (trafficJamRatio * 0.2); 
  const downhillBonus = 1 - (downhillGrade * 0.08 * regenEfficiency);
  
  const tempPenalty = 1 + Math.max(0, ambientTempDeltaC * 0.005);

  let final_consumption_rate = base_consumption * aeroFactor * totalAccelPenalty * uphillPenalty * Math.max(0.2, downhillBonus) * tempPenalty;
  
  return available_energy / final_consumption_rate;
}

function checkFeasibility(current_soc, route_distance_km, env = {}) {
  const eco_dte = calculateDTE(current_soc, 'ECO', env);
  const sport_dte = calculateDTE(current_soc, 'SPORT', env);
  
  let status = 'SAFE';
  let recommendation = 'Both ECO and SPORT modes available';
  
  if (route_distance_km > eco_dte) {
    status = 'IMPOSSIBLE';
    recommendation = 'CHARGE REQUIRED - Cannot reach destination in ECO mode';
  } else if (route_distance_km > sport_dte) {
    status = 'CRITICAL';
    recommendation = 'MUST USE ECO MODE - SPORT mode insufficient for route';
  }
  
  return {
    status,
    recommendation,
    eco_dte,
    sport_dte,
    route_distance: route_distance_km,
    safety_margin_eco: eco_dte - route_distance_km,
    safety_margin_sport: sport_dte - route_distance_km,
  };
}

function runPythonAnalytics(command, payload = {}) {
  const execution = spawnSync(CONFIG.PYTHON_EXE, [CONFIG.ANALYTICS_SCRIPT, command], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    cwd: path.join(__dirname, '..')
  });

  if (execution.error) {
    throw execution.error;
  }

  if (execution.status !== 0) {
    throw new Error(execution.stderr || `Python analytics failed for ${command}`);
  }

  return JSON.parse(execution.stdout || '{}');
}

const SAMPLE_FLEET = [
  { id: 'north-17', region: 'Northern Fleet', soh: 78.4, temperature: 39.2, cycles: 1468, voltageDiff: 0.094, maintenance: 'overdue' },
  { id: 'north-23', region: 'Northern Fleet', soh: 81.7, temperature: 36.1, cycles: 1322, voltageDiff: 0.073, maintenance: 'due soon' },
  { id: 'north-31', region: 'Northern Fleet', soh: 83.6, temperature: 34.8, cycles: 1184, voltageDiff: 0.058, maintenance: 'healthy' },
  { id: 'central-08', region: 'Central Fleet', soh: 86.9, temperature: 31.4, cycles: 975, voltageDiff: 0.047, maintenance: 'healthy' },
  { id: 'south-02', region: 'Southern Fleet', soh: 89.3, temperature: 29.7, cycles: 830, voltageDiff: 0.039, maintenance: 'healthy' }
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getRegionFromQuery(question = '') {
  const normalized = String(question).toLowerCase();

  if (normalized.includes('north')) return 'Northern Fleet';
  if (normalized.includes('south')) return 'Southern Fleet';
  if (normalized.includes('central')) return 'Central Fleet';
  return null;
}

function scoreFleetBattery(battery) {
  return (
    (100 - battery.soh) * 0.55 +
    Math.max(0, battery.temperature - 30) * 0.85 +
    Math.max(0, battery.cycles - 900) / 70 +
    battery.voltageDiff * 120 +
    (battery.maintenance === 'overdue' ? 12 : battery.maintenance === 'due soon' ? 6 : 0)
  );
}

app.post('/api/intelligence/whisperer', (req, res) => {
  try {
    const { question = '', liveContext = {} } = req.body || {};
    const result = runPythonAnalytics('whisperer', { question, liveContext });
    return res.json({
      feature: 'battery_whisperer',
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/intelligence/xai', (req, res) => {
  try {
    const result = runPythonAnalytics('xai', req.body || {});
    return res.json({
      feature: 'xai_explainability',
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/intelligence/federated', (req, res) => {
  try {
    const { rounds = 1, edgeNodes = 6 } = req.body || {};
    const result = runPythonAnalytics('federated', { rounds, edgeNodes });
    return res.json({
      feature: 'federated_learning',
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/intelligence/digital-twin', (req, res) => {
  try {
    const { baseSoh = 85, loadIncreasePct = 15, ambientTempDeltaC = 6, cycleStressPct = 18, avgSpeedKmh = 60, accelAggressionPct = 10, days = 7 } = req.body || {};
    const result = runPythonAnalytics('digital_twin', { baseSoh, loadIncreasePct, ambientTempDeltaC, cycleStressPct, avgSpeedKmh, accelAggressionPct, days });
    return res.json({
      feature: 'digital_twin',
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ROUTES - HEALTH & STATUS
// ============================================================================

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    backend_version: '1.0.0'
  });
});

/**
 * System status endpoint
 */
app.get('/api/status', async (req, res) => {
  try {
    // Check Flask server status
    const flaskStatus = await axios.get(`${CONFIG.FLASK_SERVER}/api/status`)
      .then(r => r.data)
      .catch(e => ({ error: e.message }));
    
    return res.json({
      backend: 'OK',
      flask_api: flaskStatus,
      google_maps: CONFIG.GOOGLE_MAPS_KEY !== 'YOUR_GOOGLE_MAPS_API_KEY' ? 'OK' : 'NOT_CONFIGURED',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ROUTES - PREDICTIONS
// ============================================================================

/**
 * SOC (State of Charge) Prediction
 * POST /api/predict/soc
 * Body: { features: [[V, I, T], ...] } (50 timesteps x 3 features)
 */
app.post('/api/predict/soc', async (req, res) => {
  try {
    const { features } = req.body;
    
    if (!features || features.length !== 50 || features[0].length !== 3) {
      return res.status(400).json({
        error: 'Invalid input shape. Expected (50, 3) array'
      });
    }
    
    // Call Flask LSTM API
    const response = await axios.post(`${CONFIG.FLASK_SERVER}/api/predict/soc`, {
      features
    });
    
    return res.json({
      model: 'SOC_LSTM',
      prediction: response.data.prediction,
      unit: '%',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * DTE (Distance to Empty) Calculation
 * POST /api/predict/dte
 * Body: { current_soc: 75, drive_mode: 'ECO' }
 */
app.post('/api/predict/dte', (req, res) => {
  try {
    const { current_soc = 100, drive_mode = 'ECO' } = req.body;
    
    if (current_soc < 0 || current_soc > 100) {
      return res.status(400).json({ error: 'SOC must be 0-100%' });
    }
    
    if (!['ECO', 'SPORT'].includes(drive_mode)) {
      return res.status(400).json({ error: 'Drive mode must be ECO or SPORT' });
    }
    
    const dte = calculateDTE(current_soc, drive_mode);
    
    return res.json({
      current_soc,
      drive_mode,
      estimated_range_km: dte.toFixed(2),
      battery_capacity: `${CONFIG.BATTERY.nominal_capacity}Ah @ ${CONFIG.BATTERY.nominal_voltage}V`,
      consumption_rate: `${CONFIG.CONSUMPTION[drive_mode]} Wh/km`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ROUTES - GOOGLE MAPS
// ============================================================================

/**
 * Calculate route distance using Google Maps API
 * POST /api/route/distance
 * Body: { origin: "lat,lng", destination: "lat,lng" }
 */
app.post('/api/route/distance', async (req, res) => {
  try {
    let { origin, destination, waypoints, roundTrip } = req.body;
    
    if (!origin || !destination) {
      return res.status(400).json({ error: 'Origin and destination required' });
    }
    
    if (roundTrip) {
      waypoints = waypoints ? (Array.isArray(waypoints) ? [...waypoints, destination] : [waypoints, destination]) : [destination];
      destination = origin;
    }
    
    const params = {
      key: CONFIG.GOOGLE_MAPS_KEY,
      origin,
      destination,
      mode: 'driving',
      units: 'metric'
    };
    
    if (waypoints && waypoints.length > 0) {
      params.waypoints = Array.isArray(waypoints) ? waypoints.join('|') : waypoints;
    }
    
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/directions/json',
      { params }
    );
    
    if (response.data.status !== 'OK') {
      return res.status(400).json({ error: response.data.error_message });
    }
    
    const route = response.data.routes[0];
    let distance_m = 0;
    let duration_s = 0;
    let leg_details = [];
    
    route.legs.forEach(leg => {
      distance_m += leg.distance.value;
      duration_s += leg.duration.value;
      leg_details.push({
        distance_km: leg.distance.value / 1000,
        duration_minutes: (leg.duration.value / 60).toFixed(1),
        start_address: leg.start_address,
        end_address: leg.end_address
      });
    });
    
    const distance_km = distance_m / 1000;
    
    return res.json({
      origin,
      destination,
      distance_km: distance_km.toFixed(2),
      distance_m,
      duration_s,
      duration_minutes: (duration_s / 60).toFixed(1),
      route_summary: route.summary,
      legs: leg_details
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Get route geometry (polyline for map display)
 * POST /api/route/geometry
 * Body: { origin: "lat,lng", destination: "lat,lng" }
 */
app.post('/api/route/geometry', async (req, res) => {
  try {
    const { origin, destination } = req.body;
    
    if (!origin || !destination) {
      return res.status(400).json({ error: 'Origin and destination required' });
    }
    
    const params = {
      key: CONFIG.GOOGLE_MAPS_KEY,
      origin,
      destination
    };
    
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/directions/json',
      { params }
    );
    
    if (response.data.status !== 'OK') {
      return res.status(400).json({ error: response.data.error_message });
    }
    
    const polyline = response.data.routes[0].overview_polyline.points;
    
    return res.json({
      polyline,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ROUTES - FEASIBILITY & AMSA LOGIC
// ============================================================================

/**
 * Check route feasibility with AMSA decision logic
 * POST /api/feasibility
 * Body: {
 *   current_soc: 75,
 *   origin: "lat,lng",
 *   destination: "lat,lng"
 * }
 */
app.post('/api/feasibility', async (req, res) => {
  try {
    let { 
      current_soc = 100, 
      origin, 
      destination, 
      waypoints, 
      roundTrip, 
      chargeAtStops = false,
      baseSoh = 100,
      ambientTempDeltaC = 0,
      avgSpeedKmh = 60,
      accelAggressionPct = 0
    } = req.body;
    
    if (!origin || !destination) {
      return res.status(400).json({ error: 'Origin and destination required' });
    }
    
    if (roundTrip) {
      waypoints = waypoints ? (Array.isArray(waypoints) ? [...waypoints, destination] : [waypoints, destination]) : [destination];
      destination = origin;
    }
    
    const tomtomKey = process.env.NEXT_PUBLIC_TOMTOM_API_KEY || process.env.TOMTOM_API_KEY;
    
    let total_distance_km = 0;
    let legs = [];
    let pathCoordinates = [];
    let trafficJamRatio = 0;

    const parseCoords = (c) => {
      const pts = c.split(',').map(n => Number(n.trim()));
      return { lat: pts[0], lng: pts[1] };
    };
    const orig = parseCoords(origin);
    const dest = parseCoords(destination);
    
    if (tomtomKey) {
      let routeUrl = `https://api.tomtom.com/routing/1/calculateRoute/${orig.lat},${orig.lng}`;
      if (waypoints && waypoints.length > 0) {
        const wps = Array.isArray(waypoints) ? waypoints : waypoints.split('|');
        wps.forEach(wp => {
          const p = parseCoords(wp);
          routeUrl += `:${p.lat},${p.lng}`;
        });
      }
      routeUrl += `:${dest.lat},${dest.lng}/json?key=${tomtomKey}&sectionType=traffic&traffic=true`;
      
      const routeRes = await axios.get(routeUrl);
      const routeData = routeRes.data.routes[0];
      
      total_distance_km = routeData.summary.lengthInMeters / 1000;
      
      routeData.legs.forEach(leg => {
         legs.push({ distance: { value: leg.summary.lengthInMeters }, end_address: 'Waypoint' });
         leg.points.forEach(p => pathCoordinates.push({ lat: p.latitude, lng: p.longitude }));
      });
      
      let delayMeters = 0;
      const sections = routeData.sections || [];
      sections.filter(s => s.sectionType === 'TRAFFIC').forEach(sec => {
         if (sec.simpleCategory === 'JAM' || sec.delayInSeconds > 20) {
            delayMeters += (sec.endPointIndex - sec.startPointIndex) * 50; 
         }
      });
      trafficJamRatio = Math.min(1.0, delayMeters / routeData.summary.lengthInMeters);

    } else {
       let coordsStr = `${orig.lng},${orig.lat}`;
       if (waypoints && waypoints.length > 0) {
          const wps = Array.isArray(waypoints) ? waypoints : waypoints.split('|');
          wps.forEach(wp => {
            const p = parseCoords(wp);
            coordsStr += `;${p.lng},${p.lat}`;
          });
       }
       coordsStr += `;${dest.lng},${dest.lat}`;
       
       const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=simplified&geometries=geojson`;
       const osrmRes = await axios.get(osrmUrl);
       const routeData = osrmRes.data.routes[0];
       total_distance_km = routeData.distance / 1000;
       
       const routeLegs = routeData.legs || [{distance: routeData.distance}];
       routeLegs.forEach(leg => {
          legs.push({ distance: { value: leg.distance }, end_address: 'Waypoint' });
       });
       routeData.geometry.coordinates.forEach(c => pathCoordinates.push({ lat: c[1], lng: c[0] }));
    }
    
    // 2. Fetch Free Elevation from OpenTopoData
    let uphillClimbMeters = 0;
    let downhillDescentMeters = 0;
    
    try {
      if (pathCoordinates.length > 0) {
         const sampleRate = Math.max(1, Math.floor(pathCoordinates.length / 100));
         const sampledPoints = pathCoordinates.filter((_, i) => i % sampleRate === 0);
         
         const locationsStr = sampledPoints.map(p => `${p.lat},${p.lng}`).join('|');
         const elevRes = await axios.get(`https://api.opentopodata.org/v1/srtm90m?locations=${locationsStr}`);
         
         if (elevRes.data.status === 'OK' && elevRes.data.results.length >= 2) {
            const results = elevRes.data.results;
            for(let i = 0; i < results.length - 1; i++) {
               const elev1 = results[i].elevation;
               const elev2 = results[i+1].elevation;
               if (elev1 !== null && elev2 !== null) {
                  const diff = elev2 - elev1;
                  if (diff > 0) uphillClimbMeters += diff;
                  else if (diff < 0) downhillDescentMeters += Math.abs(diff);
               }
            }
         }
      }
    } catch (e) {
      console.log('OpenTopoData fetch failed:', e.message);
    }
    
    let uphillGrade = 0;
    let downhillGrade = 0;
    if (total_distance_km > 0) {
       uphillGrade = (uphillClimbMeters / (total_distance_km * 1000)) * 100;
       downhillGrade = (downhillDescentMeters / (total_distance_km * 1000)) * 100;
    }
    
    const envParams = { 
       baseSoh, 
       ambientTempDeltaC, 
       avgSpeedKmh, 
       accelAggressionPct, 
       uphillGrade,
       downhillGrade,
       trafficJamRatio
    };

    let simulated_soc = current_soc;
    let overall_status = 'SAFE';
    let amsa_action = 'MANUAL_MODE';
    let amsa_alert = null;
    let recommendation = 'Both ECO and SPORT modes available';
    
    for (let i = 0; i < legs.length; i++) {
      const leg_dist = legs[i].distance.value / 1000;
      const leg_feasibility = checkFeasibility(simulated_soc, leg_dist, envParams);
      
      if (leg_feasibility.status === 'IMPOSSIBLE') {
        overall_status = 'IMPOSSIBLE';
        amsa_action = 'CHARGE_REQUIRED';
        amsa_alert = `⚠️ CHARGE REQUIRED - Cannot reach leg ${i+1}`;
        recommendation = `Charge needed before reaching ${legs[i].end_address}`;
        break;
      } else if (leg_feasibility.status === 'CRITICAL' && overall_status !== 'IMPOSSIBLE') {
        overall_status = 'CRITICAL';
        amsa_action = 'FORCE_ECO_MODE';
        amsa_alert = '🔴 CRITICAL - Forced ECO mode. SPORT mode disabled.';
        recommendation = 'MUST USE ECO MODE';
      }
      
      simulated_soc -= (leg_dist / leg_feasibility.eco_dte) * simulated_soc;
      if (chargeAtStops && i < legs.length - 1) {
        simulated_soc = 100;
      }
    }
    
    const feasibility = checkFeasibility(current_soc, total_distance_km, envParams);
    
    return res.json({
      current_soc,
      route_distance_km: total_distance_km.toFixed(2),
      feasibility: { ...feasibility, status: overall_status, recommendation },
      amsa_decision: {
        action: amsa_action,
        alert: amsa_alert,
        recommendation
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ERROR HANDLERS
// ============================================================================

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('iBMS BACKEND SERVER');
  console.log('='.repeat(70));
  console.log(`\n[+] Server running on http://localhost:${PORT}`);
  console.log(`[+] Flask API: ${CONFIG.FLASK_SERVER}`);
  console.log(`[+] Google Maps: ${CONFIG.GOOGLE_MAPS_KEY === 'YOUR_GOOGLE_MAPS_API_KEY' ? '❌ NOT CONFIGURED' : '✅ CONFIGURED'}`);
  console.log('\nAvailable endpoints:');
  console.log('  GET  /health                    - Health check');
  console.log('  GET  /api/status                - System status');
  console.log('  POST /api/predict/soc           - LSTM SOC prediction');
  console.log('  POST /api/predict/dte           - Distance to Empty');
  console.log('  POST /api/route/distance        - Route distance');
  console.log('  POST /api/route/geometry        - Route geometry (polyline)');
  console.log('  POST /api/feasibility           - Route feasibility + AMSA decision');
  console.log('  POST /api/intelligence/whisperer - Conversational fleet analytics');
  console.log('  POST /api/intelligence/xai       - Explainability breakdown');
  console.log('  POST /api/intelligence/federated - Federated learning snapshot');
  console.log('  POST /api/intelligence/digital-twin - What-if projection');
  console.log('\n');
});

module.exports = app;
