import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAntigravityPlugin } from './plugin';

// Mocks
vi.mock('./plugin/auth', () => ({
  isOAuthAuth: () => true,
  accessTokenExpired: () => false,
}));

vi.mock('./plugin/project', () => ({
  ensureProjectContext: () => Promise.resolve({ effectiveProjectId: 'test-project' }),
}));

vi.mock('./plugin/request', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        isGenerativeLanguageRequest: () => true,
        prepareAntigravityRequest: (input: any, init: any, token: any, projectId: any, endpoint: any) => {
             // Return a request that points to the specific endpoint so we can verify which one was called
             return {
                 request: new Request(`${endpoint}/v1/models/gemini-pro:generateContent`),
                 init: init || {},
                 streaming: false,
                 requestedModel: 'gemini-pro',
                 effectiveModel: 'gemini-pro',
                 projectId,
                 endpoint,
             };
        },
        transformAntigravityResponse: (res: any) => Promise.resolve(res),
    }
});

vi.mock('./plugin/debug', () => ({
    startAntigravityDebugRequest: () => ({}),
}));

describe('Antigravity Plugin Performance', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should be inefficient by default (calling all endpoints repeatedly)', async () => {
    const pluginFactory = createAntigravityPlugin('google');
    const pluginResult = await pluginFactory({ client: {} } as any);

    if (!pluginResult.auth || !pluginResult.auth.loader) {
        throw new Error('Loader not found');
    }

    const loader = pluginResult.auth.loader;
    const loaderResult = await loader(async () => ({ type: 'oauth', access: 'token' } as any), { models: {} } as any);

    if (!loaderResult) throw new Error('Loader result is null');

    // Simulate fetch behavior
    // First call: Daily -> 404, Autopush -> 404, Prod -> 200
    fetchMock.mockImplementation(async (req) => {
        const url = req.url.toString();
        if (url.includes('daily')) return new Response(null, { status: 404 });
        if (url.includes('autopush')) return new Response(null, { status: 404 });
        return new Response('success', { status: 200 });
    });

    await loaderResult.fetch('https://some-url', {});

    // Expect 3 calls
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Second call
    await loaderResult.fetch('https://some-url', {});

    // Expect 1 more call = 4 total (This confirms the optimization works)
    // The preferred endpoint (Prod) should be tried first and succeed immediately.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
