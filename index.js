require('dotenv').config();
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const SERIAL_PORT = process.env.TTY_PORT || '/dev/ttyUSB0';
const BAUD_RATE = 9600; // Adjust if needed

// Ensure ./data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// SQLite config using file in ./data
const dbPath = path.join(dataDir, 'ttysensor.db');
const db = new sqlite3.Database(dbPath);

// Ensure table exists
db.run(`
  CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    temperature REAL,
    humidity REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

let latestData = null;

// Serial port setup
const port = new SerialPort({ path: SERIAL_PORT, baudRate: BAUD_RATE });
const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

parser.on('data', line => {
  try {
    const data = JSON.parse(line);
    if (typeof data.temperature === 'number' && typeof data.humidity === 'number') {
      latestData = {
        temperature: data.temperature,
        humidity: data.humidity,
        timestamp: new Date()
      };
      console.log('Received data:', latestData);
      broadcastWS({ type: 'data', data: latestData });
    }
  } catch (e) {
    // Ignore parse errors
  }
});

// Insert latest data every 15 minutes
setInterval(() => {
  if (latestData) {
    db.run(
      'INSERT INTO sensor_data (temperature, humidity) VALUES (?, ?)',
      [latestData.temperature, latestData.humidity]
    );
  }
}, 15 * 60 * 1000);

// Express server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const serverStart = Date.now();

let wsClients = [];

wss.on('connection', (ws) => {
  wsClients.push(ws);
  ws.on('close', () => {
    wsClients = wsClients.filter(client => client !== ws);
  });
  // Send initial data
  if (latestData) {
    ws.send(JSON.stringify({ type: 'data', data: latestData }));
  }
});

// Broadcast helper
function broadcastWS(msg) {
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });
}

// Send uptime every second via WS
setInterval(() => {
  broadcastWS({ type: 'uptime', uptime: Date.now() - serverStart });
}, 1000);

// Express routes
app.get('/data', (req, res) => {
  if (latestData) {
    res.json(latestData);
  } else {
    res.status(404).json({ error: 'No data yet' });
  }
});

// Add separate REST APIs for temperature and humidity
app.get('/temperature', (req, res) => {
  if (latestData && typeof latestData.temperature === 'number') {
    res.json({ temperature: latestData.temperature });
  } else {
    res.status(404).json({ error: 'No data yet' });
  }
});

app.get('/humidity', (req, res) => {
  if (latestData && typeof latestData.humidity === 'number') {
    res.json({ humidity: latestData.humidity });
  } else {
    res.status(404).json({ error: 'No data yet' });
  }
});

// Endpoint for 24-hour history
app.get('/history', (req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.all(
    'SELECT temperature, humidity, created_at FROM sensor_data WHERE created_at >= ? ORDER BY created_at ASC',
    [since],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: 'DB error' });
      } else {
        res.json(rows);
      }
    }
  );
});

// Serve web interface at /
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Sensor Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: sans-serif; margin: 2em; }
    #stats { margin-bottom: 2em; }
    #chart-container { width: 100%; max-width: 700px; }
  </style>
</head>
<body>
  <h1>Sensor Dashboard</h1>
  <div id="stats">
    <div>Uptime: <span id="uptime"></span></div>
    <div>Temperature: <span id="temp"></span> °C</div>
    <div>Humidity: <span id="hum"></span> %</div>
  </div>
  <div id="chart-container">
    <canvas id="historyChart"></canvas>
  </div>
  <script>
    function formatUptime(ms) {
      let s = Math.floor(ms / 1000);
      let h = Math.floor(s / 3600);
      s = s % 3600;
      let m = Math.floor(s / 60);
      s = s % 60;
      return h + "h " + m + "m " + s + "s";
    }

    let chart;
    let chartData = {
      labels: [],
      temps: [],
      hums: []
    };

    function drawChart() {
      const ctx = document.getElementById('historyChart').getContext('2d');
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: chartData.labels,
          datasets: [
            {
              label: 'Temperature (°C)',
              data: chartData.temps,
              borderColor: 'red',
              fill: false,
              yAxisID: 'y',
            },
            {
              label: 'Humidity (%)',
              data: chartData.hums,
              borderColor: 'blue',
              fill: false,
              yAxisID: 'y1',
            }
          ]
        },
        options: {
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          stacked: false,
          scales: {
            y: { type: 'linear', position: 'left', title: { display: true, text: 'Temperature (°C)' } },
            y1: { type: 'linear', position: 'right', title: { display: true, text: 'Humidity (%)' }, grid: { drawOnChartArea: false } }
          }
        }
      });
    }

    // Initial fetch for 24h history
    fetch('/history').then(r => r.json()).then(history => {
      chartData.labels = history.map(r => new Date(r.created_at).toLocaleTimeString());
      chartData.temps = history.map(r => r.temperature);
      chartData.hums = history.map(r => r.humidity);
      drawChart();
    });

    // WebSocket for live updates
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);

    ws.onmessage = function(event) {
      const msg = JSON.parse(event.data);
      if (msg.type === 'data') {
        document.getElementById('temp').textContent = msg.data.temperature ?? '-';
        document.getElementById('hum').textContent = msg.data.humidity ?? '-';
        // Add to chart if timestamp is new
        const now = new Date(msg.data.timestamp);
        const label = now.toLocaleTimeString();
        if (chartData.labels.length === 0 || chartData.labels[chartData.labels.length - 1] !== label) {
          chartData.labels.push(label);
          chartData.temps.push(msg.data.temperature);
          chartData.hums.push(msg.data.humidity);
          // Keep only last 24h (assuming 5s interval, ~17280 points, but let's keep 300 for browser)
          if (chartData.labels.length > 300) {
            chartData.labels.shift();
            chartData.temps.shift();
            chartData.hums.shift();
          }
          drawChart();
        }
      }
      if (msg.type === 'uptime') {
        document.getElementById('uptime').textContent = formatUptime(msg.uptime);
      }
    };
  </script>
</body>
</html>
  `);
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
