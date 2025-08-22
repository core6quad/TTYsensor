#include <DHT.h>

#define DHTPIN 3
#define DHTTYPE DHT11

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(9600);
  dht.begin();
}

void loop() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();

  // Check if any reads failed and exit early (to try again next loop)
  if (isnan(h) || isnan(t)) {
    delay(5000);
    return;
  }

  Serial.print("{\"temperature\": ");
  Serial.print(t, 1);
  Serial.print(", \"humidity\": ");
  Serial.print(h, 1);
  Serial.println("}");

  delay(5000);
}
