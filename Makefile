# Makefile — hugmesh-login-ui
#
# `make pentest` runs the repo-local pen-test self-scan that MIRRORS the CI
# `pentest` stage (see .gitlab-ci.yml, which extends the centralized hidden
# .pentest-sca / .pentest-dast-baseline jobs from hugmesh-generator). This is
# a DEV / pre-push convenience: run the same OWASP checks locally before the
# pipeline does. It never hard-fails on missing tooling or a missing DAST target.

# Where the centralized DAST harness lives (run-pentest.sh + zap/nuclei/probes).
# Defaults to a sibling checkout of the generator repo; override on the CLI:
#   make pentest PENTEST_HARNESS_DIR=/path/to/hugmesh-generator/tests/pentest
PENTEST_HARNESS_DIR ?= ../hugmesh-generator/tests/pentest
# Target URL for the authenticated DAST harness. When unset, the DAST step is a
# no-op (CI stands up an env-test-build; locally you point this at a running env).
DAST_TARGET_URL ?=

.PHONY: pentest pentest-sca pentest-dast

## pentest: run the local SCA self-scan + (when targeted) the DAST harness
pentest: pentest-sca pentest-dast

## pentest-sca: Angular SCA — npm audit (mirrors CI Dependency-Check posture)
pentest-sca:
	@echo "==> [pentest:sca] npm audit (Angular SCA self-scan, mirrors CI Dependency-Check)"
	@npm audit --audit-level=high || echo "    npm audit reported findings (non-blocking locally; CI Dependency-Check --failOnCVSS 7 is authoritative)"
	@echo "==> [pentest:sca] NOTE: CI runs OWASP Dependency-Check over the full repo."
	@echo "    To mirror it locally with Docker:"
	@echo "      docker run --rm -v \"$(CURDIR):/src\" owasp/dependency-check:latest \\"
	@echo "        --project @hugmesh/login --scan /src --failOnCVSS 7 --enableExperimental \\"
	@echo "        --format HTML --out /src/reports/sca"

## pentest-dast: delegate the full DAST harness (ZAP + probes + nuclei) to the generator
pentest-dast:
	@echo "==> [pentest:dast] OWASP authenticated DAST (baseline) via the centralized harness"
	@if [ -z "$(DAST_TARGET_URL)" ]; then \
		echo "    DAST_TARGET_URL unset — skipping DAST self-scan (CI spins up an env-test-build)."; \
		echo "    To run locally against a live env:"; \
		echo "      make pentest DAST_TARGET_URL=https://login.<domain>"; \
	elif [ -x "$(PENTEST_HARNESS_DIR)/run-pentest.sh" ]; then \
		echo "    harness: $(PENTEST_HARNESS_DIR)/run-pentest.sh  target: $(DAST_TARGET_URL)"; \
		DAST_TARGET_URL="$(DAST_TARGET_URL)" bash "$(PENTEST_HARNESS_DIR)/run-pentest.sh" --scan baseline --pipeline main || \
			echo "    DAST harness reported findings/issues (non-blocking locally)."; \
	else \
		echo "    harness not found at $(PENTEST_HARNESS_DIR)/run-pentest.sh — clone the generator repo:"; \
		echo "      git clone https://github.com/hugmesh-net/hugmesh-generator ../hugmesh-generator"; \
		echo "    then re-run (or pass PENTEST_HARNESS_DIR=...). Skipping DAST for now."; \
	fi
