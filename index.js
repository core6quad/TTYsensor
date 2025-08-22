const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const fs = require('fs');
const path = require('path');

const SERIAL_PORT = '/dev/ttyUSB0';
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

const serverStart = Date.now();

app.get('/data', (req, res) => {
  if (latestData) {
    res.json(latestData);
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

    function updateStats() {
      fetch('/data').then(r => r.json()).then(data => {
        document.getElementById('temp').textContent = data.temperature ?? '-';
        document.getElementById('hum').textContent = data.humidity ?? '-';
      }).catch(() => {
        document.getElementById('temp').textContent = '-';
        document.getElementById('hum').textContent = '-';
      });
      document.getElementById('uptime').textContent = formatUptime(Date.now() - ${serverStart});
    }

    let chart;
    function drawChart(history) {
      const labels = history.map(r => new Date(r.created_at).toLocaleTimeString());
      const temps = history.map(r => r.temperature);
      const hums = history.map(r => r.humidity);
      const ctx = document.getElementById('historyChart').getContext('2d');
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Temperature (°C)',
              data: temps,
              borderColor: 'red',
              fill: false,
              yAxisID: 'y',
            },
            {
              label: 'Humidity (%)',
              data: hums,
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

    function updateChart() {
      fetch('/history').then r => r.json()).then(drawChart);
    }

    updateStats();
    updateChart();
    setInterval(updateStats, 5000);
    setInterval(updateChart, 60000);
  </script>
</body>
</html>
  `);
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
