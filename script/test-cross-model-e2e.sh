#!/bin/bash
# Cross-Model E2E Test Suite - 5 Model Variants
# Tests fix for "Invalid `signature` in `thinking` block" error
#
# Models tested:
# 1. Gemini (google/antigravity-gemini-3-pro-low, gemini-3-flash)
# 2. Claude via Anthropic (anthropic/claude-opus-4-5)
# 3. Claude via Google (google/antigravity-claude-*-thinking-*)
# 4. OpenAI (openai/gpt-5.2-medium)

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

get_session_id() {
  sleep 1
  opencode session list 2>/dev/null | grep -oP 'ses_[a-zA-Z0-9]+' | head -1 || true
}

check_signature_error() {
  grep -qi "Invalid.*signature" "$1" 2>/dev/null && return 0 || return 1
}

echo "════════════════════════════════════════════════════════════"
echo "  Cross-Model E2E Test Suite - 5 Model Variants"
echo "════════════════════════════════════════════════════════════"
echo ""

# Test 1: Gemini → Anthropic Claude (original bug + direct Anthropic API)
echo "Test 1: Gemini Pro → Anthropic Claude Opus (direct API)"
log_info "Step 1: Gemini with thinking + tool..."
opencode run -m google/antigravity-gemini-3-pro-low \
  "Run: echo 'Test1-Gemini'. Think about sequences." \
  2>&1 > /tmp/e2e-t1-s1.log || true

SID=$(get_session_id)
if [ -z "$SID" ]; then
  log_fail "Test 1 - No session ID"
else
  log_info "Session: $SID"
  log_info "Step 2: Anthropic Claude Opus + tool..."
  opencode run -s "$SID" -m anthropic/claude-opus-4-5 \
    "Run: echo 'Test1-Anthropic-Claude'" \
    2>&1 > /tmp/e2e-t1-s2.log || true
  
  if check_signature_error /tmp/e2e-t1-s2.log; then
    log_fail "Test 1 - Invalid signature error (Gemini → Anthropic Claude)"
  else
    log_pass "Test 1 - Gemini → Anthropic Claude"
  fi
fi
echo ""

# Test 2: Gemini → Google Claude (Google-hosted Claude)
echo "Test 2: Gemini Pro → Google Claude Opus Thinking"
log_info "Step 1: Gemini with thinking + tool..."
opencode run -m google/antigravity-gemini-3-pro-low \
  "Run: echo 'Test2-Gemini'. Think about this." \
  2>&1 > /tmp/e2e-t2-s1.log || true

SID=$(get_session_id)
if [ -z "$SID" ]; then
  log_fail "Test 2 - No session ID"
else
  log_info "Session: $SID"
  log_info "Step 2: Google Claude Opus Thinking + tool..."
  opencode run -s "$SID" -m google/antigravity-claude-opus-4-5-thinking-low \
    "Run: echo 'Test2-Google-Claude'" \
    2>&1 > /tmp/e2e-t2-s2.log || true
  
  if check_signature_error /tmp/e2e-t2-s2.log; then
    log_fail "Test 2 - Invalid signature error (Gemini → Google Claude)"
  else
    log_pass "Test 2 - Gemini → Google Claude Thinking"
  fi
fi
echo ""

# Test 3: Gemini → OpenAI
echo "Test 3: Gemini Pro → OpenAI GPT-5.2"
log_info "Step 1: Gemini with thinking + tool..."
opencode run -m google/antigravity-gemini-3-pro-low \
  "Run: echo 'Test3-Gemini'. Think about AI models." \
  2>&1 > /tmp/e2e-t3-s1.log || true

SID=$(get_session_id)
if [ -z "$SID" ]; then
  log_fail "Test 3 - No session ID"
else
  log_info "Session: $SID"
  log_info "Step 2: OpenAI GPT-5.2 + tool..."
  opencode run -s "$SID" -m openai/gpt-5.2-medium \
    "Run: echo 'Test3-OpenAI'" \
    2>&1 > /tmp/e2e-t3-s2.log || true
  
  if check_signature_error /tmp/e2e-t3-s2.log; then
    log_fail "Test 3 - Invalid signature error (Gemini → OpenAI)"
  elif grep -qi "api.*key\|unauthorized\|authentication" /tmp/e2e-t3-s2.log; then
    log_skip "Test 3 - OpenAI API key issue (not signature related)"
  else
    log_pass "Test 3 - Gemini → OpenAI"
  fi
fi
echo ""

# Test 4: Anthropic Claude → Gemini (reverse)
echo "Test 4: Anthropic Claude → Gemini (reverse direction)"
log_info "Step 1: Anthropic Claude with tool..."
opencode run -m anthropic/claude-opus-4-5 \
  "Run: echo 'Test4-Anthropic-Start'" \
  2>&1 > /tmp/e2e-t4-s1.log || true

SID=$(get_session_id)
if [ -z "$SID" ]; then
  log_fail "Test 4 - No session ID"
else
  log_info "Session: $SID"
  log_info "Step 2: Gemini + thinking + tool..."
  opencode run -s "$SID" -m google/antigravity-gemini-3-pro-low \
    "Run: echo 'Test4-Gemini'. Think about reversal." \
    2>&1 > /tmp/e2e-t4-s2.log || true
  
  if check_signature_error /tmp/e2e-t4-s2.log; then
    log_fail "Test 4 - Invalid signature error (Anthropic Claude → Gemini)"
  else
    log_pass "Test 4 - Anthropic Claude → Gemini"
  fi
fi
echo ""

# Test 5: OpenAI → Google Claude
echo "Test 5: OpenAI → Google Claude Sonnet Thinking"
log_info "Step 1: OpenAI with tool..."
opencode run -m openai/gpt-5.2-medium \
  "Run: echo 'Test5-OpenAI-Start'" \
  2>&1 > /tmp/e2e-t5-s1.log || true

if grep -qi "api.*key\|unauthorized\|authentication" /tmp/e2e-t5-s1.log; then
  log_skip "Test 5 - OpenAI API key issue"
else
  SID=$(get_session_id)
  if [ -z "$SID" ]; then
    log_fail "Test 5 - No session ID"
  else
    log_info "Session: $SID"
    log_info "Step 2: Google Claude Sonnet Thinking + tool..."
    opencode run -s "$SID" -m google/antigravity-claude-sonnet-4-5-thinking-low \
      "Run: echo 'Test5-Google-Claude'" \
      2>&1 > /tmp/e2e-t5-s2.log || true
    
    if check_signature_error /tmp/e2e-t5-s2.log; then
      log_fail "Test 5 - Invalid signature error (OpenAI → Google Claude)"
    else
      log_pass "Test 5 - OpenAI → Google Claude"
    fi
  fi
fi
echo ""

# Test 6: 5-Model Round-Robin (all models in sequence)
echo "Test 6: 5-Model Round-Robin"
log_info "Turn 1: Gemini Pro Low..."
opencode run -m google/antigravity-gemini-3-pro-low \
  "Run: echo 'Turn1'. Think about the chain." \
  2>&1 > /tmp/e2e-t6-s1.log || true

SID=$(get_session_id)
if [ -z "$SID" ]; then
  log_fail "Test 6 - No session ID"
else
  log_info "Session: $SID"
  CHAIN_OK=true
  
  log_info "Turn 2: Anthropic Claude..."
  opencode run -s "$SID" -m anthropic/claude-opus-4-5 \
    "Run: echo 'Turn2'" 2>&1 > /tmp/e2e-t6-s2.log || true
  check_signature_error /tmp/e2e-t6-s2.log && CHAIN_OK=false
  
  log_info "Turn 3: Google Claude Opus..."
  opencode run -s "$SID" -m google/antigravity-claude-opus-4-5-thinking-low \
    "Run: echo 'Turn3'" 2>&1 > /tmp/e2e-t6-s3.log || true
  check_signature_error /tmp/e2e-t6-s3.log && CHAIN_OK=false
  
  log_info "Turn 4: OpenAI GPT-5.2..."
  opencode run -s "$SID" -m openai/gpt-5.2-medium \
    "Run: echo 'Turn4'" 2>&1 > /tmp/e2e-t6-s4.log || true
  # Skip OpenAI check if API key issue
  if ! grep -qi "api.*key\|unauthorized" /tmp/e2e-t6-s4.log; then
    check_signature_error /tmp/e2e-t6-s4.log && CHAIN_OK=false
  fi
  
  log_info "Turn 5: Gemini Flash..."
  opencode run -s "$SID" -m google/antigravity-gemini-3-flash \
    "Run: echo 'Turn5-Complete'" 2>&1 > /tmp/e2e-t6-s5.log || true
  check_signature_error /tmp/e2e-t6-s5.log && CHAIN_OK=false
  
  if $CHAIN_OK; then
    log_pass "Test 6 - 5-Model Round-Robin"
  else
    log_fail "Test 6 - 5-Model Round-Robin (signature error in chain)"
  fi
fi
echo ""

# Test 7: Google Claude → Anthropic Claude (same family, different API)
echo "Test 7: Google Claude → Anthropic Claude (same family)"
log_info "Step 1: Google Claude Sonnet Thinking..."
opencode run -m google/antigravity-claude-sonnet-4-5-thinking-low \
  "Run: echo 'Test7-Google-Claude'" \
  2>&1 > /tmp/e2e-t7-s1.log || true

SID=$(get_session_id)
if [ -z "$SID" ]; then
  log_fail "Test 7 - No session ID"
else
  log_info "Session: $SID"
  log_info "Step 2: Anthropic Claude Opus..."
  opencode run -s "$SID" -m anthropic/claude-opus-4-5 \
    "Run: echo 'Test7-Anthropic-Claude'" \
    2>&1 > /tmp/e2e-t7-s2.log || true
  
  if check_signature_error /tmp/e2e-t7-s2.log; then
    log_fail "Test 7 - Invalid signature error (Google Claude → Anthropic Claude)"
  else
    log_pass "Test 7 - Google Claude → Anthropic Claude"
  fi
fi
echo ""

# Test 8: Triple switch with different model families
echo "Test 8: Triple Switch (Gemini → Anthropic → OpenAI)"
log_info "Step 1: Gemini Flash..."
opencode run -m google/antigravity-gemini-3-flash \
  "Run: echo 'Triple-1'. Think about it." \
  2>&1 > /tmp/e2e-t8-s1.log || true

SID=$(get_session_id)
if [ -z "$SID" ]; then
  log_fail "Test 8 - No session ID"
else
  log_info "Session: $SID"
  TRIPLE_OK=true
  
  log_info "Step 2: Anthropic Claude..."
  opencode run -s "$SID" -m anthropic/claude-opus-4-5 \
    "Run: echo 'Triple-2'" 2>&1 > /tmp/e2e-t8-s2.log || true
  check_signature_error /tmp/e2e-t8-s2.log && TRIPLE_OK=false
  
  log_info "Step 3: OpenAI..."
  opencode run -s "$SID" -m openai/gpt-5.2-medium \
    "Run: echo 'Triple-3'" 2>&1 > /tmp/e2e-t8-s3.log || true
  if ! grep -qi "api.*key\|unauthorized" /tmp/e2e-t8-s3.log; then
    check_signature_error /tmp/e2e-t8-s3.log && TRIPLE_OK=false
  fi
  
  if $TRIPLE_OK; then
    log_pass "Test 8 - Triple Switch"
  else
    log_fail "Test 8 - Triple Switch (signature error)"
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
  echo -e "${RED}Some tests failed!${NC} Check /tmp/e2e-t*.log for details"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
