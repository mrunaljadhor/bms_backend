# iBMS Backend Setup

## Installation

```bash
cd backend
npm install
```

## Configuration

### 1. Get Google Maps API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable these APIs:
   - **Directions API**
   - **Maps JavaScript API**
   - **Distance Matrix API**
4. Create an API key
5. Add to `.env`:
   ```
   GOOGLE_MAPS_KEY=your_api_key_here
   ```

### 2. Verify Flask Server Running

The backend expects the Flask LSTM API on `http://localhost:5000`:

```bash
# In another terminal
cd ..
python bms_dashboard.py
```

## Running

### Development (with auto-reload)
```bash
npm run dev
```

### Production
```bash
npm start
```

Server will start on `http://localhost:5001`

## API Endpoints

### 1. Health Check
```bash
GET /health
```

### 2. System Status
```bash
GET /api/status
```

### 3. SOC Prediction
```bash
POST /api/predict/soc
Content-Type: application/json

{
  "features": [
    [63.5, -0.7, 30],    // Voltage, Current, Temperature
    [63.4, -0.8, 30.1],
    ...                   // 50 timesteps total
  ]
}
```

### 4. Distance to Empty
```bash
POST /api/predict/dte
Content-Type: application/json

{
  "current_soc": 75,
  "drive_mode": "ECO"
}
```

Response:
```json
{
  "current_soc": 75,
  "drive_mode": "ECO",
  "estimated_range_km": "450.25",
  "battery_capacity": "60Ah @ 63.5V",
  "consumption_rate": "150 Wh/km"
}
```

### 5. Route Distance (Google Maps)
```bash
POST /api/route/distance
Content-Type: application/json

{
  "origin": "28.5355,77.3910",      // Delhi
  "destination": "28.7041,77.1025"   // Noida
}
```

### 6. Route Feasibility + AMSA Decision
```bash
POST /api/feasibility
Content-Type: application/json

{
  "current_soc": 75,
  "origin": "28.5355,77.3910",
  "destination": "28.7041,77.1025"
}
```

Response:
```json
{
  "current_soc": 75,
  "route_distance_km": "25.45",
  "feasibility": {
    "status": "CRITICAL",
    "recommendation": "MUST USE ECO MODE",
    "eco_dte": 450.25,
    "sport_dte": 270.15,
    "safety_margin_eco": 424.8,
    "safety_margin_sport": 244.7
  },
  "amsa_decision": {
    "action": "FORCE_ECO_MODE",
    "alert": "🔴 CRITICAL - Forced ECO mode. SPORT mode disabled.",
    "recommendation": "..."
  }
}
```

## AMSA Logic

### Status Levels
- **SAFE**: Both ECO and SPORT modes available
- **CRITICAL**: Only ECO mode; SPORT mode insufficient
- **IMPOSSIBLE**: Charge required; cannot reach destination

### Decision Rules
```
IF route_distance > eco_dte:
  → IMPOSSIBLE (Charge Required)
ELSE IF route_distance > sport_dte:
  → CRITICAL (Force ECO, disable SPORT)
ELSE:
  → SAFE (Allow manual mode selection)
```

## Testing with cURL

```bash
# Health check
curl http://localhost:5001/health

# SOC prediction
curl -X POST http://localhost:5001/api/predict/soc \
  -H "Content-Type: application/json" \
  -d '{
    "features": [
      [63.5, -0.7, 30],
      [63.4, -0.8, 30.1],
      ...
    ]
  }'

# DTE calculation
curl -X POST http://localhost:5001/api/predict/dte \
  -H "Content-Type: application/json" \
  -d '{"current_soc": 75, "drive_mode": "ECO"}'

# Route distance
curl -X POST http://localhost:5001/api/route/distance \
  -H "Content-Type: application/json" \
  -d '{
    "origin": "28.5355,77.3910",
    "destination": "28.7041,77.1025"
  }'

# Feasibility check
curl -X POST http://localhost:5001/api/feasibility \
  -H "Content-Type: application/json" \
  -d '{
    "current_soc": 75,
    "origin": "28.5355,77.3910",
    "destination": "28.7041,77.1025"
  }'
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 5001 | Backend server port |
| NODE_ENV | development | Environment mode |
| FLASK_SERVER | http://localhost:5000 | Flask LSTM API URL |
| GOOGLE_MAPS_KEY | - | Google Maps API key |

## Architecture

```
┌─────────────────────────────────────────┐
│        Next.js Frontend (Port 3000)      │
│   - Dashboard UI                        │
│   - Google Maps integration             │
│   - Route planner                       │
└──────────────────┬──────────────────────┘
                   │
                   ↓
┌─────────────────────────────────────────┐
│    Express Backend (Port 5001)           │
│   - LSTM predictions                    │
│   - Google Maps API wrapper             │
│   - AMSA decision logic                 │
│   - DTE calculations                    │
└──────────────────┬──────────────────────┘
                   │
           ┌───────┴────────┐
           ↓                ↓
    ┌─────────────┐  ┌──────────────┐
    │ Flask API   │  │ Google Maps  │
    │ (Port 5000) │  │ API          │
    │ LSTM Models │  │              │
    └─────────────┘  └──────────────┘
```

## Next Steps

1. Install dependencies: `npm install`
2. Configure Google Maps API key in `.env`
3. Ensure Flask server is running
4. Start backend: `npm run dev`
5. Build Next.js frontend
6. Deploy to Vercel
