#include <Servo.h>

// Define Servo Objects
Servo servo1;
Servo servo2;
Servo servo3;
Servo servo4;
Servo servo5;
Servo servo6;

// Define Arduino Pins for the 6 Servos
const int PIN_J1 = 3;
const int PIN_J2 = 5;
const int PIN_J3 = 6;
const int PIN_J4 = 9;
const int PIN_J5 = 10;
const int PIN_J6 = 11;

      
// State array holding current angles (0-180)
int jointAngles[6] = {90, 90, 90, 90, 90, 90};

// UART parsing variables
const int RX_BUFFER_SIZE = 128;
char rxBuffer[RX_BUFFER_SIZE];
int rxIndex = 0;
bool packetReady = false;

// Watchdog timer
unsigned long last_packet_time = 0;

void setup() {
  Serial.begin(115200); // Matches the Node.js server baud rate

  // Attach servos to pins
  servo1.attach(PIN_J1);
  servo2.attach(PIN_J2);
  servo3.attach(PIN_J3);
  servo4.attach(PIN_J4);
  servo5.attach(PIN_J5);
  servo6.attach(PIN_J6);

  // Set to default neutral position
  Set_Servo_Angles();
  last_packet_time = millis();
}

void loop() {
  // 1. Read incoming UART data non-blockingly
  while (Serial.available() > 0 && !packetReady) {
    char rxByte = Serial.read();
    if (rxByte == '\n') {
      rxBuffer[rxIndex] = '\0'; // Null-terminate
      packetReady = true;
    } else {
      if (rxIndex < RX_BUFFER_SIZE - 1) {
        rxBuffer[rxIndex++] = rxByte;
      } else {
        rxIndex = 0; // Overflow protection, drop packet
      }
    }
  }

  // 2. Process complete packet
  if (packetReady) {
    Process_Packet();
    rxIndex = 0;
    memset(rxBuffer, 0, RX_BUFFER_SIZE);
    packetReady = false;
  }

  // 3. Watchdog: Go to safe neutral state if connection lost for > 1000ms
  if (millis() - last_packet_time > 1000) {
    for (int i = 0; i < 6; i++) {
      jointAngles[i] = 90;
    }
    Set_Servo_Angles();
    last_packet_time = millis(); // Reset timer so it doesn't constantly spam writes
  }
}

void Process_Packet() {
  // Format: <J1:90,J2:180,J3:0,J4:45,J5:90,J6:90*CHECKSUM>
  char *start = strchr(rxBuffer, '<');
  char *end = strchr(rxBuffer, '>');
  char *star = strchr(rxBuffer, '*');

  if (start && end && star && (star > start) && (end > star)) {
    // Calculate XOR checksum
    uint8_t calc_checksum = 0;
    for (char *p = start + 1; p < star; p++) {
      calc_checksum ^= *p;
    }

    // Read received checksum (HEX string to integer)
    uint8_t recv_checksum = (uint8_t)strtol(star + 1, NULL, 16);

    if (calc_checksum == recv_checksum) {
      // Parse individual joint angles
      char *ptr = start + 1;
      for (int i = 0; i < 6; i++) {
        char searchStr[5];
        sprintf(searchStr, "J%d:", i + 1);
        char *found = strstr(ptr, searchStr);
        if (found && found < star) {
          jointAngles[i] = atoi(found + 3);
        }
      }
      
      // Update hardware
      Set_Servo_Angles();
      last_packet_time = millis();
    } else {
      // Checksum mismatch, ignore packet
      Serial.println("Error: Checksum mismatch");
    }
  }
}

void Set_Servo_Angles() {
  // Constrain to 0-180 just to be safe
  for (int i = 0; i < 6; i++) {
    if (jointAngles[i] < 0) jointAngles[i] = 0;
    if (jointAngles[i] > 180) jointAngles[i] = 180;
  }

  servo1.write(jointAngles[0]);
  servo2.write(jointAngles[1]);
  servo3.write(jointAngles[2]);
  servo4.write(jointAngles[3]);
  servo5.write(jointAngles[4]);
  servo6.write(jointAngles[5]);
}
