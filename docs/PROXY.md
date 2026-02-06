# Proxy Configuration Example

## OAuth Login Proxy (Recommended)

**New in v1.3.4**: Use the `ANTIGRAVITY_LOGIN_PROXY` environment variable to configure proxy during account login. The proxy URL will be saved to the account automatically.

```bash
# Login with proxy
ANTIGRAVITY_LOGIN_PROXY=http://proxy.example.com:8080 opencode auth login

# Login with authenticated proxy
ANTIGRAVITY_LOGIN_PROXY=http://user:pass@proxy.example.com:8080 opencode auth login
```

The proxy URL is saved to `~/.config/opencode/antigravity-accounts.json` and used for:
- All OAuth token refreshes
- Project discovery API calls
- Gemini/Claude API requests
- Google Search tool requests
- Quota check requests

**Benefits:**
- No manual JSON editing required
- Proxy is automatically associated with the account
- All future API calls from this account use the configured proxy

## Manual Proxy Configuration (Alternative)

Alternatively, you can manually edit your `~/.config/opencode/antigravity-accounts.json` file and add `proxyUrl` fields to each account:

```json
{
  "version": 3,
  "accounts": [
    {
      "email": "user1@gmail.com",
      "refreshToken": "1//0abc...",
      "projectId": "my-project-1",
      "proxyUrl": "http://user1:password1@proxy1.example.com:8080",
      "addedAt": 1704067200000,
      "lastUsed": 1704153600000
    },
    {
      "email": "user2@gmail.com",
      "refreshToken": "1//0def...",
      "projectId": "my-project-2",
      "proxyUrl": "http://user2:password2@proxy2.example.com:8080",
      "addedAt": 1704067300000,
      "lastUsed": 1704153700000
    },
    {
      "email": "user3@gmail.com",
      "refreshToken": "1//0ghi...",
      "projectId": "my-project-3",
      "proxyUrl": "https://proxy3.example.com:443",
      "addedAt": 1704067400000,
      "lastUsed": 1704153800000
    }
  ],
  "activeIndex": 0,
  "activeIndexByFamily": {
    "claude": 0,
    "gemini": 1
  }
}
```

## Supported Proxy Formats

- **HTTP**: `http://[user:pass@]host:port`
- **HTTPS**: `https://[user:pass@]host:port`

**Note**: SOCKS5 proxies are NOT currently supported. Use HTTP/HTTPS proxies only.

## Anti-Detection Features

1. **Hard Fail**: If proxy fails, request fails immediately - NO direct fallback
2. **All Traffic**: Token refresh, project discovery, and API calls all use same proxy
3. **Per-Account Isolation**: Each account uses its own proxy → unique IP per account
4. **Connection Pooling**: Proxy connections are cached and reused for performance

## Important Notes

- **Credentials**: Proxy passwords stored in plaintext (same security level as OAuth tokens)
- **Backward Compatible**: Accounts without `proxyUrl` work unchanged (direct connection)
- **Restart Required**: Changes to `antigravity-accounts.json` require OpenCode restart
- **Error Handling**: Failed proxy connections mark account "cooling down" for 30 seconds

## Testing Your Proxies

Before adding proxies to all accounts, test one account first:

```bash
# Test proxy during login
ANTIGRAVITY_LOGIN_PROXY=http://localhost:8080 opencode auth login

# Watch your proxy logs - you should see:
# - POST https://oauth2.googleapis.com/token
# - GET https://www.googleapis.com/oauth2/v1/userinfo
# - POST to Antigravity loadCodeAssist endpoints

# Make a test request
opencode run "Hello" --model=google/claude-sonnet-4-5

# Proxy logs should show API traffic
```

## Troubleshooting

### Proxy Connection Failed

```
Error: Failed to create proxy agent for http://proxy:8080: connect ECONNREFUSED
```

**Solutions:**
- Check proxy URL format: `http://host:port` (not `https://` unless TLS-enabled proxy)
- Test proxy with curl: `curl -x http://proxy:8080 https://google.com`
- Ensure proxy is running and accessible
- Check firewall rules

### Invalid Proxy URL Format

```
Error: Invalid proxy URL format: http://***:***@:invalid
```

**Solutions:**
- Ensure URL format is correct: `http://user:pass@host:port`
- Host must be valid hostname or IP address
- Port must be numeric

### Account Cooldown After Proxy Failures

If proxy fails 5 times consecutively, the account enters a 30-second cooldown to prevent cascading failures.

**Solutions:**
- Fix proxy configuration
- Wait 30 seconds for cooldown to expire
- Check proxy logs for error details
