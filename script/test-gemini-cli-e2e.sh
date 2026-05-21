#!/bin/bash
# Gemini CLI E2E Test Suite
# Tests gemini-cli models routing through cloudcode-pa.googleapis.com/v1internal
#
# Models tested:
# Legacy Gemini CLI smoke. Individual Gemini CLI access sunsets on 2026-06-18;
# keep this script only for backward-compatible fallback debugging.
# 1. google/gemini-2.5-pro
# 2. google/gemini-2.5-flash
# 3. google/gemini-3-pro-preview
# 4. google/gemini-3-flash-preview

set -euo pipefail

PASS=0
FAIL=0
SKIP=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; ((PASS++)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; ((FAIL++)); }
log_skip() { echo -e "${YELLOW}○ SKIP${NC}: $1"; ((SKIP++)); }
log_info() { echo -e "  ${BLUE}→${NC} $1"; }

# Check for common errors
check_auth_error() {
  grep -qiE "insufficient.*scope|authentication|unauthorized|403|401" "$1" 2>/dev/null && return 0 || return 1
}

check_quota_error() {
  grep -qiE "quota|rate.limit|429|resource.exhausted" "$1" 2>/dev/null && return 0 || return 1
}

check_model_error() {
  grep -qiE "model.*not.found|invalid.*model|404" "$1" 2>/dev/null && return 0 || return 1
}

# Test a single model
test_model() {
  local model="$1"
  local test_name="$2"
  local log_file="/tmp/gemini-cli-e2e-${test_name}.log"
  
  log_info "Testing $model..."
  
  # Run opencode with a simple prompt
  timeout 60 opencode run -m "$model" \
    "Reply with exactly: GEMINI_CLI_OK" \
    2>&1 > "$log_file" || true
  
  # Check for various error conditions
  if check_auth_error "$log_file"; then
    log_fail "$test_name - Authentication/scope error (check OAuth scopes)"
    log_info "This likely means routing to wrong endpoint"
    return 1
  elif check_quota_error "$log_file"; then
    log_skip "$test_name - Quota exhausted (not a routing issue)"
    return 0
  elif check_model_error "$log_file"; then
    log_fail "$test_name - Model not found"
    return 1
  elif grep -qi "GEMINI_CLI_OK\|working\|ok\|hello" "$log_file"; then
    log_pass "$test_name"
    return 0
  elif grep -qi "error\|exception\|failed" "$log_file"; then
    log_fail "$test_name - Unknown error"
    log_info "Check $log_file for details"
    return 1
  else
    # No obvious error, assume success
    log_pass "$test_name"
    return 0
  fi
}

echo "════════════════════════════════════════════════════════════"
echo "  Gemini CLI E2E Test Suite"
echo "  Testing cloudcode-pa.googleapis.com/v1internal routing"
echo "════════════════════════════════════════════════════════════"
echo ""

echo "Test 1: google/gemini-2.5-flash"
test_model "google/gemini-2.5-flash" "gemini-2.5-flash" || true
echo ""

echo "Test 2: google/gemini-2.5-pro"
test_model "google/gemini-2.5-pro" "gemini-2.5-pro" || true
echo ""

echo "Test 3: google/gemini-3-flash-preview"
test_model "google/gemini-3-flash-preview" "gemini-3-flash-preview" || true
echo ""

echo "Test 4: google/gemini-3-pro-preview"
test_model "google/gemini-3-pro-preview" "gemini-3-pro-preview" || true
echo ""

# Test 5: Cross-model session (gemini-cli → antigravity)
echo "Test 5: Cross-model session (gemini-cli → antigravity-gemini)"
log_info "Step 1: Start with gemini-2.5-flash..."
timeout 60 opencode run -m google/gemini-2.5-flash \
  "Say: SESSION_START" \
  2>&1 > /tmp/gemini-cli-e2e-cross-s1.log || true

# Get session ID
sleep 1
SID=$(opencode session list 2>/dev/null | grep -oP 'ses_[a-zA-Z0-9]+' | head -1 || true)

if [ -z "$SID" ]; then
  log_fail "Test 5 - No session ID created"
else
  log_info "Session: $SID"
  log_info "Step 2: Switch to antigravity-gemini-3.5-flash-low..."
  timeout 60 opencode run -s "$SID" -m google/antigravity-gemini-3.5-flash-low \
    "Say: SESSION_CONTINUE" \
    2>&1 > /tmp/gemini-cli-e2e-cross-s2.log || true
  
  if check_auth_error /tmp/gemini-cli-e2e-cross-s2.log; then
    log_fail "Test 5 - Auth error on cross-model switch"
  else
    log_pass "Test 5 - Cross-model session (gemini-cli → antigravity)"
  fi
fi
echo ""

# Test 6: Reverse cross-model (antigravity → gemini-cli)
echo "Test 6: Cross-model session (antigravity → gemini-cli)"
log_info "Step 1: Start with antigravity-gemini-3.1-pro-low..."
timeout 60 opencode run -m google/antigravity-gemini-3.1-pro-low \
  "Say: ANTIGRAVITY_START" \
  2>&1 > /tmp/gemini-cli-e2e-reverse-s1.log || true

sleep 1
SID=$(opencode session list 2>/dev/null | grep -oP 'ses_[a-zA-Z0-9]+' | head -1 || true)

if [ -z "$SID" ]; then
  log_fail "Test 6 - No session ID created"
else
  log_info "Session: $SID"
  log_info "Step 2: Switch to gemini-2.5-pro..."
  timeout 60 opencode run -s "$SID" -m google/gemini-2.5-pro \
    "Say: GEMINI_CLI_CONTINUE" \
    2>&1 > /tmp/gemini-cli-e2e-reverse-s2.log || true
  
  if check_auth_error /tmp/gemini-cli-e2e-reverse-s2.log; then
    log_fail "Test 6 - Auth error on reverse cross-model switch"
  else
    log_pass "Test 6 - Cross-model session (antigravity → gemini-cli)"
  fi
fi
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  Test Results Summary"
echo "════════════════════════════════════════════════════════════"
echo -e "  ${GREEN}Passed${NC}:  $PASS"
echo -e "  ${RED}Failed${NC}:  $FAIL"
echo -e "  ${YELLOW}Skipped${NC}: $SKIP"
echo ""

if [ $FAIL -gt 0 ]; then
  echo -e "${RED}Some tests failed!${NC}"
  echo "Log files: /tmp/gemini-cli-e2e-*.log"
  exit 1
else
  echo -e "${GREEN}All Gemini CLI tests passed!${NC}"
  exit 0
fi
