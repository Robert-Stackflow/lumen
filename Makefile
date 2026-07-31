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
	python3 tests/session_schema.py
	python3 tests/login_template.py
	python3 tests/audit_contract.py
	python3 tests/button_typography.py
	python3 tests/placeholder_typography.py
	python3 tests/operations_settings.py
	@if command -v node >/dev/null 2>&1; then \
		node tests/selection.js; \
		node tests/session_manager.js; \
		node tests/runtime.js; \
		node tests/split_layout.js; \
		node tests/audit_log.js; \
		node tests/command_snippets.js; \
		node tests/diagnostics.js; \
		node --check web/context-menu.js; \
		node --check web/terminal-connection.js; \
		node --check web/diagnostics.js; \
		node --check web/app.js; \
	else \
		echo "node unavailable; selection unit tests skipped"; \
	fi
	bash -n scripts/run-dev.sh scripts/install.sh scripts/bootstrap-debian.sh \
		scripts/lumen-shell-integration.sh
	python3 -m py_compile scripts/lumen-auth
	test -s dist/index.html
	test -x bin/lumen-ttyd
	test -x bin/lumen-pty
	bin/lumen-pty --help >/dev/null
	bash tests/supervisor.sh

clean:
	rm -rf build bin/lumen-ttyd bin/lumen-pty dist/index.html
