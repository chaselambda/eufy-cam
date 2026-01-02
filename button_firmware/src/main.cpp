#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// Hardware pins
constexpr int LED_PIN = D2;    // GPIO4
constexpr int BUTTON_PIN = D1; // GPIO5

// LED is connected to 5V, so pulling LOW turns it on
void setLed(bool on) { digitalWrite(LED_PIN, on ? LOW : HIGH); }

// Button has pull-up, so pressing grounds it (reads LOW)
bool isButtonPressed() { return digitalRead(BUTTON_PIN) == LOW; }

// WiFi and MQTT configuration - update these for your network
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
const char* mqtt_server = "YOUR_MQTT_SERVER_IP"; // e.g., "192.168.1.100"
constexpr int mqtt_port = 2000;
const char* mqtt_user = "user";
const char* mqtt_password = "pass";

// MQTT Topics
const char* TOPIC_PACKAGE_EXISTS = "package_exists";
const char* TOPIC_USER_HANDLED = "user_handled";

// Timing constants
constexpr unsigned long LED_FLASH_INTERVAL_MS = 500;
constexpr unsigned long COOLDOWN_DURATION_MS = 2 * 60 * 1000; // 2 minutes
constexpr unsigned long DEBOUNCE_DELAY_MS = 50;

// State
WiFiClient espClient;
PubSubClient client(espClient);

bool packageExists = false;
bool inCooldown = false;
unsigned long cooldownStartTime = 0;
unsigned long lastLedToggle = 0;
bool ledState = false;

// Button debounce
bool lastButtonPressed = false;
unsigned long lastDebounceTime = 0;

void setup_wifi() {
  delay(10);
  Serial.println();
  Serial.print("Connecting to ");
  Serial.println(ssid);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  randomSeed(micros());

  Serial.println("");
  Serial.println("WiFi connected");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
}

void publishUserHandled() {
  StaticJsonDocument<128> doc;
  doc["handled"] = true;
  doc["timestamp"] = millis();

  char buffer[128];
  serializeJson(doc, buffer);

  Serial.print("Publishing user_handled: ");
  Serial.println(buffer);

  client.publish(TOPIC_USER_HANDLED, buffer);
}

void handleButtonPress() {
  Serial.println("Button pressed - user handled package");
  publishUserHandled();

  // Enter cooldown
  inCooldown = true;
  cooldownStartTime = millis();

  // Turn off LED during cooldown
  setLed(false);
  ledState = false;
}

void callback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Message arrived [");
  Serial.print(topic);
  Serial.print("]: ");

  // Print payload for debugging
  for (unsigned int i = 0; i < length; i++) {
    Serial.print((char)payload[i]);
  }
  Serial.println();

  // Parse JSON
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, payload, length);

  if (error) {
    Serial.print("deserializeJson() failed: ");
    Serial.println(error.f_str());
    return;
  }

  if (strcmp(topic, TOPIC_PACKAGE_EXISTS) == 0) {
    bool exists = doc["exists"] | false;
    Serial.print("Package exists: ");
    Serial.println(exists ? "true" : "false");
    packageExists = exists;

    // If package no longer exists, clear cooldown and turn off LED
    if (!exists) {
      inCooldown = false;
      setLed(false);
      ledState = false;
    }
  } else if (strcmp(topic, TOPIC_USER_HANDLED) == 0) {
    // Someone (another button or ourselves) handled the package
    bool handled = doc["handled"] | false;
    if (handled) {
      Serial.println("Received user_handled - entering cooldown");
      inCooldown = true;
      cooldownStartTime = millis();
      setLed(false);
      ledState = false;
    }
  }
}

void reconnect() {
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection...");

    // Generate unique client ID
    String clientId = "ESP8266-Button-";
    clientId += String(random(0xffff), HEX);

    if (client.connect(clientId.c_str(), mqtt_user, mqtt_password)) {
      Serial.println("connected");

      // Subscribe to topics
      client.subscribe(TOPIC_PACKAGE_EXISTS);
      client.subscribe(TOPIC_USER_HANDLED);
      Serial.println("Subscribed to package_exists and user_handled");
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" - retrying in 5 seconds");
      delay(5000);
    }
  }
}

void updateLed() {
  if (!packageExists || inCooldown) {
    // LED should be off
    if (ledState) {
      setLed(false);
      ledState = false;
    }
    return;
  }

  // Package exists and not in cooldown - flash LED
  unsigned long now = millis();
  if (now - lastLedToggle >= LED_FLASH_INTERVAL_MS) {
    lastLedToggle = now;
    ledState = !ledState;
    setLed(ledState);
  }
}

void checkCooldown() {
  if (inCooldown) {
    unsigned long elapsed = millis() - cooldownStartTime;
    if (elapsed >= COOLDOWN_DURATION_MS) {
      Serial.println("Cooldown complete");
      inCooldown = false;
      // LED will resume flashing in updateLed() if package still exists
    }
  }
}

void checkButton() {
  bool pressed = isButtonPressed();

  // Debounce
  if (pressed != lastButtonPressed) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > DEBOUNCE_DELAY_MS) {
    // Button state has been stable
    if (pressed && !lastButtonPressed) {
      // Button just pressed
      if (packageExists && !inCooldown) {
        handleButtonPress();
      }
    }
  }

  lastButtonPressed = pressed;
}

void setup() {
  Serial.begin(115200);

  while (!Serial) {
    delay(10);
  }

  Serial.println();
  Serial.println("Package Notification Button Starting...");

  // Configure pins
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  setLed(false);

  // Setup WiFi and MQTT
  setup_wifi();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);

  Serial.println("Setup complete");
}

void loop() {
  // Maintain MQTT connection
  if (!client.connected()) {
    reconnect();
  }
  client.loop();

  // Check button
  checkButton();

  // Update cooldown state
  checkCooldown();

  // Update LED
  updateLed();
}
