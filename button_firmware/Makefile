.PHONY: build upload monitor clean

build:
	platformio run

upload:
	platformio run -t upload

monitor:
	pio device monitor -b 115200

clean:
	platformio run -t clean
