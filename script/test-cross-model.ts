#!/usr/bin/env npx tsx
import {
  sanitizeCrossModelPayload,
  getModelFamily,
} from '../src/plugin/transform/cross-model-sanitizer';

const GEMINI_THOUGHT_SIGNATURE = 'EsgQCsUQAXLI2nybuafAE150LGTo2r78fakesig123abc456def789';

const geminiHistoryWithThinkingAndToolCall = {
  contents: [
    {
      role: 'user',
      parts: [{ text: 'Check disk space. Think about which filesystems are most utilized.' }]
    },
    {
      role: 'model',
      parts: [
        {
          thought: true,
          text: 'Let me analyze the disk usage by running df -h to see filesystem utilization...',
          thoughtSignature: GEMINI_THOUGHT_SIGNATURE
        },
        {
          functionCall: { 
            name: 'Bash', 
            args: { command: 'df -h', description: 'Check disk space' } 
          },
          metadata: {
            google: {
              thoughtSignature: GEMINI_THOUGHT_SIGNATURE
            }
          }
        }
      ]
    },
    {
      role: 'function',
      parts: [{
        functionResponse: {
          name: 'Bash',
          response: { 
            output: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       100G   62G   38G  62% /' 
          }
        }
      }]
    },
    {
      role: 'model',
      parts: [{ text: 'The root filesystem is 62% utilized, which is moderate usage.' }]
    }
  ]
};

function runTests(): void {
  console.log('=== Cross-Model Sanitization E2E Test ===\n');
  
  let passed = 0;
  let failed = 0;

  console.log('Test 1: Model family detection');
  const geminiFamily = getModelFamily('gemini-3-pro-low');
  const claudeFamily = getModelFamily('claude-opus-4-6-thinking-medium');
  if (geminiFamily === 'gemini' && claudeFamily === 'claude') {
    console.log('  ✅ PASS: Model families detected correctly');
    passed++;
  } else {
    console.log(`  ❌ FAIL: Expected gemini/claude, got ${geminiFamily}/${claudeFamily}`);
    failed++;
  }

  console.log('\nTest 2: Gemini → Claude sanitization (exact bug reproduction)');
  console.log('  Input: Gemini session with thinking + tool call containing thoughtSignature');
  
  const result = sanitizeCrossModelPayload(geminiHistoryWithThinkingAndToolCall, {
    targetModel: 'claude-opus-4-6-thinking-medium'
  });

  const payload = result.payload as any;
  const modelParts = payload.contents[1].parts;
  const thinkingPart = modelParts[0];
  const toolPart = modelParts[1];

  if (thinkingPart.thoughtSignature === undefined) {
    console.log('  ✅ PASS: Top-level thoughtSignature stripped from thinking part');
    passed++;
  } else {
    console.log('  ❌ FAIL: thoughtSignature still present on thinking part');
    failed++;
  }

  if (toolPart.metadata?.google?.thoughtSignature === undefined) {
    console.log('  ✅ PASS: Nested metadata.google.thoughtSignature stripped from tool part');
    passed++;
  } else {
    console.log('  ❌ FAIL: metadata.google.thoughtSignature still present');
    failed++;
  }

  if (toolPart.functionCall?.name === 'Bash') {
    console.log('  ✅ PASS: functionCall structure preserved');
    passed++;
  } else {
    console.log('  ❌ FAIL: functionCall corrupted');
    failed++;
  }

  if (result.modified && result.signaturesStripped === 2) {
    console.log(`  ✅ PASS: Sanitization metrics correct (modified=true, stripped=${result.signaturesStripped})`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: Metrics incorrect (modified=${result.modified}, stripped=${result.signaturesStripped})`);
    failed++;
  }

  console.log('\nTest 3: Same model family - no sanitization');
  const sameFamily = sanitizeCrossModelPayload(geminiHistoryWithThinkingAndToolCall, {
    targetModel: 'gemini-3-flash'
  });

  if (!sameFamily.modified && sameFamily.signaturesStripped === 0) {
    console.log('  ✅ PASS: No sanitization for same model family');
    passed++;
  } else {
    console.log('  ❌ FAIL: Should not sanitize same model family');
    failed++;
  }

  console.log('\n=== Results ===');
  console.log(`Passed: ${passed}/${passed + failed}`);
  console.log(`Failed: ${failed}/${passed + failed}`);
  
  if (failed > 0) {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ All E2E tests passed');
  }
}

runTests();
