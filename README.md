# TTYsensor

a simple nodejs web app to monitor temperature and humidity using your arduino
and a DHT11 (Others may be supported too) sensor.

works only under linux for now.

## Installation

1. clone the repository
2. flash the sketch (Optimized for Uno+DHT11) with DHT11 Data on the pin 3
3. connect the arduino to your pc running linux and figure out where it's serial output can be found (ls /dev), usually /dev/ttyUSB0
4. make a .env file that looks like .env.example but contains a path to the serial port
5. edit docker-compose.yml to pass your serial device
6. docker compose up
7. visit your-ip:3000