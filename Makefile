SHELL := /bin/bash

.PHONY: all build frontend backend supervisor clean check

all: build

build: frontend backend supervisor

frontend:
	python3 tools/build_index.py

backend:
	cmake -S vendor/ttyd -B build/ttyd -DCMAKE_BUILD_TYPE=Release
	cmake --build build/ttyd --parallel
	mkdir -p bin
	install -m 0755 build/ttyd/ttyd bin/lumen-ttyd

supervisor: src/lumen-pty.c
	mkdir -p bin
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c11 -O2 -Wall -Wextra -Wpedantic \
		-D_FORTIFY_SOURCE=2 -fstack-protector-strong \
		-o bin/lumen-pty src/lumen-pty.c -lutil $(LDFLAGS)

check: build
	python3 -m py_compile tools/build_index.py
	python3 tests/theme_contract.py
	bash -n scripts/run-dev.sh scripts/install.sh scripts/bootstrap-debian.sh
	python3 -m py_compile scripts/lumen-auth
	test -s dist/index.html
	test -x bin/lumen-ttyd
	test -x bin/lumen-pty
	bin/lumen-pty --help >/dev/null
	bash tests/supervisor.sh

clean:
	rm -rf build bin/lumen-ttyd bin/lumen-pty dist/index.html
