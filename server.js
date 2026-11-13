const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const configStorePath = path.join(root, 'server-configs.enc');
const clientId = process.env.DISCORD_CLIENT_ID || '1570124723147514058';
const clientSecret = process.env.DISCORD_CLIENT_SECRET;
const discordOAuthConfigured = Boolean(clientId && clientSecret && clientSecret !== 'replace-with-your-discord-client-secret');
const storageSecret = process.env.ERLY_ENCRYPTION_SECRET || clientSecret;
const botToken = process.env.DISCORD_BOT_TOKEN;
const storageKey = crypto.createHash('sha256').update(String(storageSecret)).digest();
const deploymentHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
const defaultRedirectUri = deploymentHost
  ? `https://${deploymentHost.replace(/^https?:\/\//, '')}/auth/discord/callback`
  : `http://localhost:${port}/auth/discord/callback`;
const redirectUri = process.env.DISCORD_REDIRECT_URI || defaultRedirectUri;
const sessionLifetime = 365 * 24 * 60 * 60;
const stateLifetime = 10 * 60;
const welcomePollInterval = 3_000;
const commandInterval = 5_000;
const sessions = new Map();
const welcomeMonitors = new Map();
let persistentConfigs = null;
let persistentConfigLoad = null;
let persistentConfigWrite = Promise.resolve();
const staticFiles = new Map([
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.html', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/privacy.html', ['privacy.html', 'text/html; charset=utf-8']],
  ['/terms.html', ['terms.html', 'text/html; charset=utf-8']],
  ['/servers.html', ['servers.html', 'text/html; charset=utf-8']],
  ['/insights.html', ['insights.html', 'text/html; charset=utf-8']],
  ['/configuration.html', ['configuration.html', 'text/html; charset=utf-8']],
  ['/map.html', ['map.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/script.js', ['script.js', 'text/javascript; charset=utf-8']],
  ['/configuration.js', ['configuration.js', 'text/javascript; charset=utf-8']],
  ['/map.js', ['map.js', 'text/javascript; charset=utf-8']]
]);
const protectedPages = new Set([
  '/dashboard.html',
  '/servers.html',
  '/insights.html',
  '/configuration.html',
  '/map.html'
]);

if (!discordOAuthConfigured) {
  console.error('Discord OAuth is not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.');
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie || '';
  for (const cookie of cookies.split(';')) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return '';
}

function setCookie(response, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (process.env.VERCEL === '1') parts.push('Secure');
  response.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(response, name, cookiePath = '/') {
  const secure = process.env.VERCEL === '1' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${name}=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getSession(request) {
  const sessionId = cookieValue(request, 'erly_session');
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function stopWelcomeMonitor(config) {
  const monitor = welcomeMonitors.get(config.guildId);
  if (!monitor) return;
  monitor.stopped = true;
  if (monitor.welcomePollTimer) clearTimeout(monitor.welcomePollTimer);
  if (monitor.welcomeCommandTimer) clearTimeout(monitor.welcomeCommandTimer);
  welcomeMonitors.delete(config.guildId);
}

function retryWelcomePoll(config, delay) {
  if (config.stopped) return;
  if (config.welcomePollTimer) clearTimeout(config.welcomePollTimer);
  config.welcomePollTimer = setTimeout(() => {
    if (config.stopped) return;
    config.welcomePollTimer = setInterval(() => {
      void pollWelcomePlayers(config);
    }, welcomePollInterval);
    void pollWelcomePlayers(config);
  }, delay);
}

function publicErlcServer(server) {
  if (!server) return null;
  const publicServer = { ...server };
  delete publicServer.serverApiKey;
  delete publicServer.ownerDiscordUserId;
  delete publicServer.welcomeJoinLogSnapshot;
  delete publicServer.welcomePendingUsers;
  delete publicServer.welcomeDeliveryCode;
  publicServer.serverApiKeySaved = Boolean(server.serverApiKey);
  return publicServer;
}

async function loadPersistentConfigs() {
  if (persistentConfigs) return persistentConfigs;
  if (!persistentConfigLoad) {
    persistentConfigLoad = (async () => {
      try {
        const payload = await fs.readFile(configStorePath, 'utf8');
        const [ivHex, authTagHex, encryptedHex] = payload.split(':');
        if (!ivHex || !authTagHex || !encryptedHex) throw new Error('Invalid encrypted server configuration file.');
        const decipher = crypto.createDecipheriv('aes-256-gcm', storageKey, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
        const decrypted = Buffer.concat([
          decipher.update(Buffer.from(encryptedHex, 'hex')),
          decipher.final()
        ]).toString('utf8');
        const parsed = JSON.parse(decrypted);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Invalid server configuration data.');
        }
        persistentConfigs = parsed;
      } catch (error) {
        if (error.code === 'ENOENT') {
          persistentConfigs = {};
          return persistentConfigs;
        }
        throw error;
      }
      return persistentConfigs;
    })();
  }
  try {
    return await persistentConfigLoad;
  } catch (error) {
    persistentConfigLoad = null;
    throw error;
  }
}

function persistServerConfig(config) {
  const write = persistentConfigWrite.then(async () => {
    const current = await loadPersistentConfigs();
    const previous = current[config.guildId];
    const preserveProgress = previous?.ownerDiscordUserId === config.ownerDiscordUserId;
    const savedConfig = {
      ...config,
      ...(preserveProgress ? {
        sessionChannelId: config.sessionChannelId ?? previous.sessionChannelId,
        sessionChannelName: config.sessionChannelName ?? previous.sessionChannelName
      } : {}),
      ...(preserveProgress && previous.welcomeJoinLogSnapshot
        ? { welcomeJoinLogSnapshot: previous.welcomeJoinLogSnapshot }
        : {}),
      ...(preserveProgress && previous.welcomePendingUsers
        ? { welcomePendingUsers: previous.welcomePendingUsers }
        : {})
    };
    const next = { ...current, [config.guildId]: savedConfig };
    await writePersistentConfigStore(next);
    return savedConfig;
  });
  persistentConfigWrite = write.then(() => undefined, () => undefined);
  return write;
}

async function writePersistentConfigStore(next) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', storageKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(next), 'utf8'),
    cipher.final()
  ]);
  const payload = `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
  const temporaryPath = `${configStorePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, configStorePath);
  persistentConfigs = next;
}

function persistWelcomeProgress(config) {
  const snapshot = [...config.welcomeJoinLogCounts.entries()].sort(([left], [right]) => left.localeCompare(right));
  const write = persistentConfigWrite.then(async () => {
    const current = await loadPersistentConfigs();
    const savedConfig = current[config.guildId];
    if (!savedConfig || savedConfig.updatedAt !== config.updatedAt) return;
    await writePersistentConfigStore({
      ...current,
      [config.guildId]: {
        ...savedConfig,
        welcomeJoinLogSnapshot: snapshot,
        welcomePendingUsers: [...config.welcomeCommandQueue]
      }
    });
  });
  persistentConfigWrite = write.then(() => undefined, () => undefined);
  return write;
}

function persistWelcomeDeliveryStatus(config, status, error = '', code = '') {
  const write = persistentConfigWrite.then(async () => {
    const current = await loadPersistentConfigs();
    const savedConfig = current[config.guildId];
    if (!savedConfig || savedConfig.updatedAt !== config.updatedAt) return;
    await writePersistentConfigStore({
      ...current,
      [config.guildId]: {
        ...savedConfig,
        welcomeDeliveryStatus: status,
        welcomeDeliveryError: error,
        welcomeDeliveryCode: code,
        welcomePendingUsers: [...config.welcomeCommandQueue]
      }
    });
  });
  persistentConfigWrite = write.then(() => undefined, () => undefined);
  return write;
}

async function saveWelcomeDeliveryStatus(config, status, error = '', code = '') {
  config.welcomeDeliveryStatus = status;
  config.welcomeDeliveryError = error;
  config.welcomeDeliveryCode = code;
  try {
    await persistWelcomeDeliveryStatus(config, status, error, code);
  } catch (saveError) {
    console.error('ER:LC welcome delivery status could not be saved:', saveError.message);
  }
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  response.end(message);
}

function redirect(response, location) {
  response.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  response.end();
}

async function handleDiscordCallback(url, request, response) {
  const returnedState = url.searchParams.get('state') || '';
  const savedState = cookieValue(request, 'erly_oauth_state');

  if (!returnedState || !savedState || !secureEqual(returnedState, savedState)) {
    return sendText(response, 400, 'Discord sign-in could not be verified. Please try again.');
  }

  clearCookie(response, 'erly_oauth_state', '/auth/discord/callback');

  if (url.searchParams.has('error')) {
    return redirect(response, '/?auth=denied');
  }

  const code = url.searchParams.get('code');
  if (!code) return sendText(response, 400, 'Discord did not return an authorization code.');

  const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });

  if (!tokenResponse.ok) {
    console.error(`Discord token exchange failed with HTTP ${tokenResponse.status}.`);
    return sendText(response, 502, 'Discord sign-in failed while exchanging the authorization code. Check your local OAuth configuration.');
  }

  const tokenData = await tokenResponse.json();
  if (typeof tokenData.access_token !== 'string') {
    console.error('Discord token exchange returned no access token.');
    return sendText(response, 502, 'Discord sign-in did not return a usable access token.');
  }

  const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });

  if (!userResponse.ok) {
    console.error(`Discord profile request failed with HTTP ${userResponse.status}.`);
    return sendText(response, 502, 'Discord sign-in succeeded, but ERLY could not retrieve your Discord profile.');
  }

  const user = await userResponse.json();
  if (typeof user.id !== 'string' || typeof user.username !== 'string') {
    console.error('Discord profile response was missing required user fields.');
    return sendText(response, 502, 'Discord returned an incomplete user profile.');
  }

  const sessionId = crypto.randomBytes(32).toString('base64url');
  sessions.set(sessionId, {
    user: {
      id: user.id,
      username: user.username,
      displayName: typeof user.global_name === 'string' && user.global_name ? user.global_name : user.username,
      avatar: typeof user.avatar === 'string' ? user.avatar : null,
      email: typeof user.email === 'string' ? user.email : null
    },
    accessToken: tokenData.access_token,
    refreshToken: typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token : null,
    accessTokenExpiresAt: Date.now() + Math.max(0, Number(tokenData.expires_in) || 0) * 1000,
    guilds: null,
    expiresAt: Date.now() + sessionLifetime * 1000
  });

  setCookie(response, 'erly_session', sessionId, { maxAge: sessionLifetime });
  return redirect(response, '/dashboard.html');
}

async function getValidDiscordAccessToken(session) {
  if (session.accessTokenExpiresAt > Date.now() + 60_000) return session.accessToken;
  if (!session.refreshToken) {
    const error = new Error('Your Discord sign-in needs renewal. Please sign out and sign in again.');
    error.statusCode = 401;
    throw error;
  }
  if (session.tokenRefreshPromise) return session.tokenRefreshPromise;

  session.tokenRefreshPromise = (async () => {
    const response = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken
      })
    });

    if (!response.ok) {
      const error = new Error(
        response.status === 400 || response.status === 401
          ? 'Your Discord sign-in needs renewal. Please sign out and sign in again.'
          : `Discord token refresh failed with HTTP ${response.status}.`
      );
      error.statusCode = response.status === 400 || response.status === 401 ? 401 : 502;
      throw error;
    }

    const tokenData = await response.json();
    if (typeof tokenData.access_token !== 'string' || typeof tokenData.refresh_token !== 'string') {
      const error = new Error('Discord token refresh returned incomplete credentials.');
      error.statusCode = 502;
      throw error;
    }

    session.accessToken = tokenData.access_token;
    session.refreshToken = tokenData.refresh_token;
    session.accessTokenExpiresAt = Date.now() + Math.max(0, Number(tokenData.expires_in) || 0) * 1000;
    return session.accessToken;
  })();

  try {
    return await session.tokenRefreshPromise;
  } finally {
    session.tokenRefreshPromise = null;
  }
}

async function fetchUserGuilds(accessToken) {
  const guilds = [];
  let after;

  for (let page = 0; page < 20; page += 1) {
    const url = new URL('https://discord.com/api/v10/users/@me/guilds');
    url.searchParams.set('limit', '200');
    url.searchParams.set('with_counts', 'true');
    if (after) url.searchParams.set('after', after);

    const result = await fetch(url, {
      headers: { Authorization: 'Bearer ' + accessToken }
    });

    if (!result.ok) {
      const error = new Error(
        result.status === 401 || result.status === 403
          ? 'Discord server access was not authorized. Sign out and sign in again to grant the guilds permission.'
          : `Discord server list request failed with HTTP ${result.status}.`
      );
      error.statusCode = result.status === 401 || result.status === 403 ? 403 : 502;
      throw error;
    }

    const batch = await result.json();
    if (!Array.isArray(batch)) {
      const error = new Error('Discord returned an invalid server list.');
      error.statusCode = 502;
      throw error;
    }

    guilds.push(...batch);
    if (batch.length < 200) break;
    after = batch[batch.length - 1]?.id;
    if (!after) break;
  }

  return guilds;
}

async function readJsonBody(request, maximumBytes = 8192) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > maximumBytes) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Request must contain valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

async function fetchWithTransientRetry(resource, options, serviceName) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(resource, options);
    } catch (error) {
      if (attempt === 2) {
        const failure = new Error(`${serviceName} could not be reached. Check your connection and try again.`);
        failure.statusCode = 502;
        throw failure;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }

    if (![502, 503, 504].includes(response.status) || attempt === 2) return response;
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 500 * (attempt + 1);
    if (delay > 5000) return response;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`${serviceName} request could not be completed.`);
}

async function verifyErlcServer(serverApiKey) {
  const serverResponse = await fetchWithTransientRetry(
    'https://api.erlc.gg/v2/server',
    { headers: { 'server-key': serverApiKey } },
    'ER:LC API'
  );

  if (serverResponse.status === 401 || serverResponse.status === 403) {
    const error = new Error('The ER:LC API key was rejected. Check that you copied the private server key correctly.');
    error.statusCode = 400;
    throw error;
  }
  if (serverResponse.status === 429) {
    const retryAfter = Number(serverResponse.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? ` Wait ${Math.ceil(retryAfter)} seconds before retrying.` : ' Wait a moment before retrying.';
    const error = new Error(`ER:LC API is rate-limiting requests.${wait}`);
    error.statusCode = 429;
    throw error;
  }
  if (!serverResponse.ok) {
    const temporary = serverResponse.status >= 500;
    const error = new Error(temporary
      ? `ER:LC is temporarily unavailable (HTTP ${serverResponse.status}). Please wait a moment and try again.`
      : `ER:LC server verification failed with HTTP ${serverResponse.status}.`);
    error.statusCode = temporary ? 503 : 502;
    throw error;
  }

  const server = await serverResponse.json();
  if (
    typeof server.Name !== 'string' ||
    (typeof server.OwnerId !== 'number' && typeof server.OwnerId !== 'string') ||
    typeof server.JoinKey !== 'string'
  ) {
    const error = new Error('ER:LC returned incomplete server ownership data, so ERLY cannot verify this setup.');
    error.statusCode = 502;
    throw error;
  }

  const ownerResponse = await fetchWithTransientRetry(
    `https://users.roblox.com/v1/users/${encodeURIComponent(server.OwnerId)}`,
    {},
    'Roblox user lookup'
  );
  if (ownerResponse.status === 429) {
    const error = new Error('Roblox is rate-limiting requests. Wait a moment before verifying the server again.');
    error.statusCode = 503;
    throw error;
  }
  if (!ownerResponse.ok) {
    const temporary = ownerResponse.status >= 500;
    const error = new Error(temporary
      ? `Roblox is temporarily unavailable (HTTP ${ownerResponse.status}). Please wait a moment and try again.`
      : `Roblox server-owner lookup failed with HTTP ${ownerResponse.status}.`);
    error.statusCode = temporary ? 503 : 502;
    throw error;
  }
  const owner = await ownerResponse.json();
  if (typeof owner.name !== 'string') {
    const error = new Error('Roblox did not return a username for the ER:LC server owner.');
    error.statusCode = 502;
    throw error;
  }

  return {
    serverName: server.Name,
    ownerRobloxId: String(server.OwnerId),
    ownerRobloxUsername: owner.name,
    joinCode: server.JoinKey
  };
}

async function fetchErlcJoinLogs(serverApiKey) {
  const response = await fetch('https://api.erlc.gg/v1/server/joinlogs', {
    headers: { 'server-key': serverApiKey }
  });
  if (response.status === 429) {
    const error = new Error('ER:LC join-log checks are rate limited.');
    error.statusCode = 429;
    error.retryAfter = Number(response.headers.get('retry-after')) || 15;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`ER:LC join-log check failed with HTTP ${response.status}.`);
    error.statusCode = response.status;
    throw error;
  }
  const joinLogs = await response.json();
  if (!Array.isArray(joinLogs)) {
    throw new Error('ER:LC returned invalid join logs.');
  }

  return joinLogs.map((entry) => {
    if (
      !entry ||
      typeof entry.Player !== 'string' ||
      typeof entry.Timestamp !== 'number' ||
      typeof entry.Join !== 'boolean'
    ) {
      throw new Error('ER:LC returned an invalid join-log entry.');
    }
    return {
      key: `${entry.Timestamp}:${entry.Player}:${entry.Join}`,
      username: entry.Player.split(':')[0],
      joined: entry.Join,
      timestamp: entry.Timestamp < 1_000_000_000_000 ? entry.Timestamp * 1000 : entry.Timestamp
    };
  }).filter((entry) => entry.joined && /^[A-Za-z0-9_]{3,20}$/.test(entry.username));
}

async function sendErlcCommand(serverApiKey, command) {
  return fetch('https://api.erlc.gg/v2/server/command', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'server-key': serverApiKey
    },
    body: JSON.stringify({ command })
  });
}

async function erlcResponseDetails(response) {
  const body = await response.text();
  if (!body) return { message: '', code: '' };
  try {
    const data = JSON.parse(body);
    const message = data.message || data.Message || data.error || data.Error || '';
    const code = data.code ?? data.Code ?? '';
    return {
      message: typeof message === 'string' ? message.slice(0, 300) : '',
      code: String(code).slice(0, 32)
    };
  } catch {
    return { message: body.replace(/\s+/g, ' ').slice(0, 300), code: '' };
  }
}

function scheduleWelcomeCommand(config) {
  if (
    config.stopped ||
    config.welcomeCommandTimer ||
    config.welcomeCommandRunning ||
    !config.welcomeCommandQueue?.length ||
    !config.welcomeMessage
  ) return;

  const wait = Math.max(0, commandInterval - (Date.now() - (config.lastWelcomeCommandAt || 0)));
  config.welcomeCommandTimer = setTimeout(() => {
    config.welcomeCommandTimer = null;
    void dispatchWelcomeCommand(config);
  }, wait);
}

async function dispatchWelcomeCommand(config) {
  if (config.stopped || config.welcomeCommandRunning || !config.welcomeMessage) return;
  const username = config.welcomeCommandQueue[0];
  if (!username) return;

  config.welcomeCommandRunning = true;
  config.lastWelcomeCommandAt = Date.now();
  try {
    let response;
    try {
      response = await sendErlcCommand(config.serverApiKey, `:pm ${username} ${config.welcomeMessage}`);
    } catch (error) {
      console.error(`ER:LC welcome message for ${username} could not be sent:`, error.message);
      config.welcomeCommandRetryCount = (config.welcomeCommandRetryCount || 0) + 1;
      const delay = Math.min(60_000, commandInterval * (2 ** Math.min(config.welcomeCommandRetryCount, 4)));
      config.lastWelcomeCommandAt = Date.now() + delay - commandInterval;
      await saveWelcomeDeliveryStatus(config, 'waiting', 'Could not reach ER:LC. ERLY will retry the welcome message.');
      return;
    }

    const details = response.ok ? { message: '', code: '' } : await erlcResponseDetails(response);
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after')) || 5;
      config.lastWelcomeCommandAt = Date.now() + Math.max(commandInterval, retryAfter * 1000) - commandInterval;
      console.error(`ER:LC welcome message was rate limited; retrying after ${retryAfter} seconds.`);
      await saveWelcomeDeliveryStatus(
        config,
        'waiting',
        details.message || 'ER:LC rate limit reached. ERLY will retry the welcome message.',
        details.code
      );
    } else if (response.status >= 500) {
      config.welcomeCommandRetryCount = (config.welcomeCommandRetryCount || 0) + 1;
      const delay = Math.min(60_000, commandInterval * (2 ** Math.min(config.welcomeCommandRetryCount, 4)));
      config.lastWelcomeCommandAt = Date.now() + delay - commandInterval;
      const error = details.message || `ER:LC returned HTTP ${response.status}.`;
      console.error(`ER:LC welcome message for ${username} failed with HTTP ${response.status}: ${error}`);
      await saveWelcomeDeliveryStatus(config, 'waiting', `${error} ERLY will retry.`, details.code);
    } else if (!response.ok) {
      const error = details.message || `ER:LC rejected the :pm command with HTTP ${response.status}.`;
      console.error(`ER:LC welcome message for ${username} failed with HTTP ${response.status} (API code ${details.code || 'unknown'}): ${error}`);
      if (response.status === 401 || response.status === 403) {
        await saveWelcomeDeliveryStatus(config, 'error', error, details.code);
        stopWelcomeMonitor(config);
      } else {
        config.welcomeCommandQueue.shift();
        try {
          await persistWelcomeProgress(config);
        } catch (saveError) {
          console.error('ER:LC welcome queue progress could not be saved:', saveError.message);
        }
        await saveWelcomeDeliveryStatus(config, 'error', error, details.code);
      }
    } else {
      config.welcomeCommandRetryCount = 0;
      config.welcomeCommandQueue.shift();
      try {
        await persistWelcomeProgress(config);
      } catch (saveError) {
        console.error('ER:LC welcome queue progress could not be saved:', saveError.message);
      }
      await saveWelcomeDeliveryStatus(
        config,
        config.welcomeCommandQueue.length ? 'sending' : 'active'
      );
    }
  } finally {
    config.welcomeCommandRunning = false;
    if (!config.stopped) scheduleWelcomeCommand(config);
  }
}

async function pollWelcomePlayers(config) {
  if (config.stopped || !config.welcomeMessage) {
    stopWelcomeMonitor(config);
    return;
  }
  if (config.welcomePollRunning) return;

  config.welcomePollRunning = true;
  try {
    const joinLogs = await fetchErlcJoinLogs(config.serverApiKey);
    if (config.stopped || !config.welcomeMessage) return;
    config.welcomePollRetryCount = 0;
    if (config.welcomeDeliveryStatus === 'waiting' && !config.welcomeCommandQueue.length) {
      await saveWelcomeDeliveryStatus(config, 'active');
    }
    const currentJoinLogCounts = new Map();
    const newcomers = [];
    for (const entry of joinLogs) {
      const occurrence = currentJoinLogCounts.get(entry.key) || 0;
      currentJoinLogCounts.set(entry.key, occurrence + 1);
      if (config.welcomeJoinLogCounts && occurrence >= (config.welcomeJoinLogCounts.get(entry.key) || 0)) {
        newcomers.push(entry.username);
      }
    }

    const snapshotChanged = !config.welcomeJoinLogCounts ||
      JSON.stringify([...currentJoinLogCounts.entries()].sort(([left], [right]) => left.localeCompare(right))) !==
        JSON.stringify([...config.welcomeJoinLogCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
    config.welcomeJoinLogCounts = currentJoinLogCounts;
    config.welcomeCommandQueue.push(...newcomers);
    if (newcomers.length && config.welcomeDeliveryStatus !== 'sending') {
      config.welcomeDeliveryStatus = 'sending';
      config.welcomeDeliveryError = '';
      void persistWelcomeDeliveryStatus(config, 'sending').catch((error) => {
        console.error('ER:LC welcome status could not be saved:', error.message);
      });
    }
    if (snapshotChanged) {
      try {
        await persistWelcomeProgress(config);
      } catch (error) {
        console.error('ER:LC join-log progress could not be saved:', error.message);
        return;
      }
    }
    scheduleWelcomeCommand(config);
  } catch (error) {
    console.error('ER:LC join monitor could not check join logs:', error.message);
    if (error.statusCode === 401 || error.statusCode === 403) {
      await saveWelcomeDeliveryStatus(config, 'error', error.message);
      stopWelcomeMonitor(config);
    } else if (!config.stopped) {
      config.welcomePollRetryCount = (config.welcomePollRetryCount || 0) + 1;
      const delay = error.statusCode === 429
        ? error.retryAfter * 1000
        : Math.min(60_000, welcomePollInterval * (2 ** Math.min(config.welcomePollRetryCount - 1, 5)));
      await saveWelcomeDeliveryStatus(config, 'waiting', `${error.message} ERLY will retry.`);
      retryWelcomePoll(config, delay);
    }
  } finally {
    config.welcomePollRunning = false;
  }
}

function startWelcomeMonitor(config) {
  stopWelcomeMonitor(config);
  if (!config.welcomeMessage) return;
  const monitor = {
    ...config,
    welcomeDeliveryStatus: config.welcomeDeliveryStatus || 'active',
    welcomeJoinLogCounts: Array.isArray(config.welcomeJoinLogSnapshot)
      ? new Map(config.welcomeJoinLogSnapshot.filter((entry) =>
        Array.isArray(entry) && typeof entry[0] === 'string' && Number.isInteger(entry[1]) && entry[1] > 0
      ))
      : null,
    welcomeCommandQueue: Array.isArray(config.welcomePendingUsers)
      ? config.welcomePendingUsers.filter((username) => typeof username === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(username))
      : [],
    stopped: false
  };
  welcomeMonitors.set(config.guildId, monitor);
  void pollWelcomePlayers(monitor);
  monitor.welcomePollTimer = setInterval(() => {
    void pollWelcomePlayers(monitor);
  }, welcomePollInterval);
}

async function fetchBotGuildProfile(guildId) {
  const url = new URL(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`);
  url.searchParams.set('with_counts', 'true');
  const result = await fetch(url, {
    headers: { Authorization: 'Bot ' + botToken }
  });

  if (!result.ok) {
    const error = new Error(
      result.status === 404 || result.status === 403
        ? 'ERLY cannot access this Discord server. Add the ERLY bot to continue.'
        : `Discord server profile request failed with HTTP ${result.status}.`
    );
    error.statusCode = result.status === 429 ? 503 : result.status === 404 || result.status === 403 ? 409 : 502;
    throw error;
  }
  return result.json();
}

async function fetchBotGuildChannels(guildId) {
  const response = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, {
    headers: { Authorization: 'Bot ' + botToken }
  });
  if (!response.ok) {
    const error = new Error(
      response.status === 403 || response.status === 404
        ? 'ERLY cannot read this server’s channels. Check that the bot is still in the server.'
        : `Discord channel list request failed with HTTP ${response.status}.`
    );
    error.statusCode = response.status === 429 ? 503 : response.status === 403 || response.status === 404 ? 409 : 502;
    throw error;
  }

  const channels = await response.json();
  if (!Array.isArray(channels)) {
    const error = new Error('Discord returned an invalid channel list.');
    error.statusCode = 502;
    throw error;
  }
  const categoryNames = new Map(
    channels.filter((channel) => channel.type === 4).map((channel) => [channel.id, channel.name])
  );
  return channels
    .filter((channel) => channel.type === 0 || channel.type === 5)
    .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name))
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      categoryName: categoryNames.get(channel.parent_id) || 'Channels'
    }));
}

function createUniquePlayerMetrics(joinLogs, range) {
  const rangeOptions = {
    '90d': { duration: 90 * 24 * 60 * 60 * 1000, bucket: 24 * 60 * 60 * 1000, label: '90 days', bucketLabel: 'day' },
    '60d': { duration: 60 * 24 * 60 * 60 * 1000, bucket: 24 * 60 * 60 * 1000, label: '60 days', bucketLabel: 'day' },
    '7d': { duration: 7 * 24 * 60 * 60 * 1000, bucket: 60 * 60 * 1000, label: '7 days', bucketLabel: 'hour' },
    '1h': { duration: 60 * 60 * 1000, bucket: 60 * 1000, label: '1 hour', bucketLabel: 'minute' }
  };
  const rangeOption = rangeOptions[range];
  const now = Date.now();
  const start = now - rangeOption.duration;
  const uniquePlayers = new Set();
  const playersByHour = new Map();
  for (const entry of joinLogs) {
    if (entry.timestamp < start || entry.timestamp > now) continue;
    const username = entry.username.toLowerCase();
    const bucket = Math.floor(entry.timestamp / rangeOption.bucket) * rangeOption.bucket;
    uniquePlayers.add(username);
    if (!playersByHour.has(bucket)) playersByHour.set(bucket, new Set());
    playersByHour.get(bucket).add(username);
  }

  const history = [];
  const firstBucket = Math.floor(start / rangeOption.bucket) * rangeOption.bucket;
  const lastBucket = Math.floor(now / rangeOption.bucket) * rangeOption.bucket;
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += rangeOption.bucket) {
    history.push({
      timestamp: bucket,
      uniquePlayers: playersByHour.get(bucket)?.size || 0
    });
  }

  return {
    totalUniquePlayers: uniquePlayers.size,
    history,
    range,
    rangeLabel: rangeOption.label,
    bucketLabel: rangeOption.bucketLabel
  };
}

function canManageGuild(guild) {
  if (guild.owner) return true;
  try {
    const permissions = BigInt(guild.permissions || '0');
    return (permissions & 0x8n) !== 0n || (permissions & 0x20n) !== 0n;
  } catch {
    return false;
  }
}

async function serveStatic(pathname, request, response, isMapPreview = false) {
  const entry = staticFiles.get(pathname);
  if (!entry) return sendText(response, 404, 'Not found.');

  if (pathname === '/index.html' && getSession(request)) {
    return redirect(response, '/dashboard.html');
  }

  if (protectedPages.has(pathname) && !isMapPreview && !getSession(request)) {
    return redirect(response, '/');
  }
  if (pathname === '/map.html' && !isMapPreview && !getSession(request)?.erlcServer) {
    return redirect(response, '/dashboard.html');
  }

  try {
    const content = await fs.readFile(path.join(root, entry[0]));
    response.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY'
    });
    response.end(content);
  } catch (error) {
    console.error(`Could not read ${entry[0]}:`, error.message);
    sendText(response, 500, 'The requested ERLY page could not be loaded.');
  }
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  } catch {
    return sendText(response, 400, 'Invalid request URL.');
  }

  if (request.method === 'GET' && url.pathname === '/auth/discord') {
    if (!discordOAuthConfigured) {
      return sendText(response, 503, 'Discord sign-in is not configured. Set DISCORD_CLIENT_SECRET in the deployment environment.');
    }
    const state = crypto.randomBytes(32).toString('base64url');
    setCookie(response, 'erly_oauth_state', state, {
      maxAge: stateLifetime,
      path: '/auth/discord/callback'
    });
    const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify email guilds guilds.members.read',
      state
    }).toString();
    return redirect(response, authorizeUrl.toString());
  }

  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
    return response.end();
  }

  if (request.method === 'GET' && url.pathname === '/auth/discord/add-bot') {
    const session = getSession(request);
    if (!session) return redirect(response, '/?auth=denied');

    const guildId = url.searchParams.get('guild_id') || '';
    const guild = session.guilds?.guilds.find((entry) => entry.id === guildId);
    if (!/^\d{17,20}$/.test(guildId) || !guild || !guild.canManage) {
      return sendText(response, 403, 'Choose a Discord server you can manage before adding the ERLY bot.');
    }

    const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      scope: 'bot applications.commands',
      permissions: '3072',
      guild_id: guildId,
      disable_guild_select: 'true'
    }).toString();
    return redirect(response, authorizeUrl.toString());
  }

  if (request.method === 'GET' && url.pathname === '/auth/discord/callback') {
    if (!discordOAuthConfigured) {
      return sendText(response, 503, 'Discord sign-in is not configured. Set DISCORD_CLIENT_SECRET in the deployment environment.');
    }
    try {
      return await handleDiscordCallback(url, request, response);
    } catch (error) {
      console.error('Discord OAuth callback failed:', error.message);
      if (!response.headersSent) return sendText(response, 502, 'Discord sign-in could not be completed. Check the local server logs.');
      return response.end();
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/me') {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Not signed in.');
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return response.end(JSON.stringify({ user: session.user }));
  }

  if (request.method === 'GET' && url.pathname === '/api/guilds') {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Not signed in.');

    try {
      const forceRefresh = url.searchParams.get('refresh') === '1';
      if (forceRefresh || !session.guilds || Date.now() - session.guilds.fetchedAt > 60_000) {
        const guilds = await fetchUserGuilds(await getValidDiscordAccessToken(session));

        session.guilds = {
          fetchedAt: Date.now(),
          botConfigured: Boolean(botToken),
          guilds: guilds.map((guild) => ({
            id: guild.id,
            name: guild.name,
            icon: guild.icon,
            owner: Boolean(guild.owner),
            canManage: canManageGuild(guild),
            botPresent: null,
            approximateMemberCount: guild.approximate_member_count ?? null,
            botInviteUrl: botToken && canManageGuild(guild)
              ? `/auth/discord/add-bot?guild_id=${encodeURIComponent(guild.id)}`
              : null
          }))
        };
      }

      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(JSON.stringify(session.guilds));
    } catch (error) {
      console.error('Discord server list could not be loaded:', error.message);
      return sendText(response, error.statusCode || 502, error.message || 'Could not load Discord servers.');
    }
  }

  if (request.method === 'GET' && /^\/api\/guilds\/\d+\/membership$/.test(url.pathname)) {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Not signed in.');

    const guildId = url.pathname.split('/')[3];
    const guild = session.guilds?.guilds.find((entry) => entry.id === guildId);
    if (!guild) return sendText(response, 403, 'Choose a Discord server from your server list.');
    if (!botToken) return sendText(response, 503, 'ERLY bot is not configured on this site.');

    try {
      await fetchBotGuildProfile(guildId);
      guild.botPresent = true;
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(JSON.stringify({ botPresent: true }));
    } catch (error) {
      if (error.statusCode === 409) {
        guild.botPresent = false;
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        return response.end(JSON.stringify({ botPresent: false }));
      }
      console.error('Discord server membership could not be checked:', error.message);
      return sendText(response, error.statusCode || 502, error.message || 'Could not check ERLY membership.');
    }
  }

  if (request.method === 'GET' && /^\/api\/guilds\/\d+\/profile$/.test(url.pathname)) {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Not signed in.');

    const guildId = url.pathname.split('/')[3];
    const guild = session.guilds?.guilds.find((entry) => entry.id === guildId);
    if (!guild) return sendText(response, 403, 'Choose a Discord server from your server list.');
    if (!guild.canManage) return sendText(response, 403, 'You need server management permission to connect ERLY.');
    if (!botToken) return sendText(response, 503, 'ERLY bot is not configured on this site.');

    try {
      const profile = await fetchBotGuildProfile(guildId);
      guild.botPresent = true;
      const createdAt = new Date(Number((BigInt(guildId) >> 22n) + 1420070400000n)).toISOString();
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(JSON.stringify({
        id: profile.id,
        name: profile.name,
        description: profile.description || '',
        icon: profile.icon || null,
        banner: profile.banner || null,
        approximateMemberCount: profile.approximate_member_count ?? null,
        approximatePresenceCount: profile.approximate_presence_count ?? null,
        boostCount: profile.premium_subscription_count ?? null,
        preferredLocale: profile.preferred_locale || '',
        verificationLevel: profile.verification_level ?? null,
        ownerId: profile.owner_id || '',
        features: Array.isArray(profile.features) ? profile.features : [],
        createdAt
      }));
    } catch (error) {
      if (error.statusCode === 409) guild.botPresent = false;
      console.error('Discord server profile could not be loaded:', error.message);
      return sendText(response, error.statusCode || 502, error.message || 'Could not load this Discord server profile.');
    }
  }

  if (request.method === 'GET' && /^\/api\/guilds\/\d+\/channels$/.test(url.pathname)) {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Not signed in.');

    const guildId = url.pathname.split('/')[3];
    const guild = session.guilds?.guilds.find((entry) => entry.id === guildId);
    if (!guild?.canManage) return sendText(response, 403, 'You need server management permission to configure ERLY.');
    if (!botToken || guild.botPresent !== true) {
      return sendText(response, 409, 'Add the ERLY bot to this Discord server before choosing a session channel.');
    }

    try {
      const channels = await fetchBotGuildChannels(guildId);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(JSON.stringify({ channels }));
    } catch (error) {
      console.error('Discord server channels could not be loaded:', error.message);
      return sendText(response, error.statusCode || 502, error.message || 'Could not load Discord server channels.');
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/map') {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Sign in with Discord before opening the map simulation.');
    if (!session.erlcServer) return sendText(response, 409, 'Verify an ER:LC private server before opening the map simulation.');
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return response.end(JSON.stringify({
      serverName: session.erlcServer.serverName,
      discordServerName: session.erlcServer.discordGuildName,
      ownerRobloxUsername: session.erlcServer.ownerRobloxUsername,
      joinCode: session.erlcServer.joinCode,
      mode: 'original-demo'
    }));
  }

  if (request.method === 'GET' && url.pathname === '/api/erlc/current') {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Not signed in.');
    let savedConfigs = [];
    try {
      const configs = await loadPersistentConfigs();
      savedConfigs = Object.values(configs)
        .filter((config) => config.ownerDiscordUserId === session.user.id)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      const requestedGuildId = url.searchParams.get('guild_id');
      if (requestedGuildId) {
        session.erlcServer = savedConfigs.find((config) => config.guildId === requestedGuildId) || null;
        if (!session.erlcServer) return sendText(response, 404, 'No saved ER:LC server setup was found for this Discord server.');
      } else {
        const currentConfig = session.erlcServer ? configs[session.erlcServer.guildId] : null;
        session.erlcServer = currentConfig?.ownerDiscordUserId === session.user.id
          ? currentConfig
          : savedConfigs[0] || null;
      }
    } catch (error) {
      console.error('Saved ER:LC configuration could not be loaded:', error.message);
      return sendText(response, 500, 'Saved server details could not be loaded. Check the local server logs.');
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return response.end(JSON.stringify({
      server: publicErlcServer(session.erlcServer),
      servers: savedConfigs.map((config) => publicErlcServer(config))
    }));
  }

  if (request.method === 'POST' && url.pathname === '/api/erlc/session-channel') {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Sign in before configuring session management.');

    const origin = request.headers.origin;
    if (origin && origin !== new URL(redirectUri).origin) {
      return sendText(response, 403, 'This setup request did not come from the local ERLY site.');
    }
    if (!session.erlcServer?.serverApiKey || session.erlcServer.ownerDiscordUserId !== session.user.id) {
      return sendText(response, 409, 'Select and verify an ER:LC server before configuring session management.');
    }

    let input;
    try {
      input = await readJsonBody(request);
    } catch (error) {
      return sendText(response, error.statusCode || 400, error.message);
    }
    if (!input || typeof input.channelId !== 'string' || !/^\d{17,20}$/.test(input.channelId)) {
      return sendText(response, 400, 'Choose a valid Discord channel.');
    }

    const guild = session.guilds?.guilds.find((entry) => entry.id === session.erlcServer.guildId);
    if (!guild?.canManage) return sendText(response, 403, 'You need server management permission to configure ERLY.');
    if (guild.botPresent !== true) {
      return sendText(response, 409, 'Add the ERLY bot to this Discord server before choosing a session channel.');
    }

    try {
      const channels = await fetchBotGuildChannels(guild.id);
      const selectedChannel = channels.find((channel) => channel.id === input.channelId);
      if (!selectedChannel) return sendText(response, 400, 'Choose a text or announcement channel from this server.');

      const savedConfig = await persistServerConfig({
        ...session.erlcServer,
        sessionChannelId: selectedChannel.id,
        sessionChannelName: selectedChannel.name,
        updatedAt: Date.now()
      });
      session.erlcServer = savedConfig;
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(JSON.stringify({ server: publicErlcServer(savedConfig) }));
    } catch (error) {
      console.error('Session notification channel could not be saved:', error.message);
      return sendText(response, error.statusCode || 502, error.message || 'Could not save the session channel.');
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/erlc/session-metrics') {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Sign in to view server metrics.');
    try {
      const range = url.searchParams.get('range') || '1h';
      if (!['90d', '60d', '7d', '1h'].includes(range)) {
        return sendText(response, 400, 'Choose a supported metrics range: 90d, 60d, 7d, or 1h.');
      }
      const requestedGuildId = url.searchParams.get('guild_id');
      if (requestedGuildId && !/^\d{17,20}$/.test(requestedGuildId)) {
        return sendText(response, 400, 'Choose a valid Discord server.');
      }
      const configs = requestedGuildId ? await loadPersistentConfigs() : null;
      const serverConfig = requestedGuildId
        ? configs[requestedGuildId]
        : session.erlcServer;
      if (!serverConfig?.serverApiKey || serverConfig.ownerDiscordUserId !== session.user.id) {
        return sendText(response, 409, 'Select and verify an ER:LC server before viewing player metrics.');
      }
      if (!session.guilds?.guilds.some((guild) => guild.id === serverConfig.guildId && guild.canManage)) {
        return sendText(response, 403, 'You need server management permission to view this server’s metrics.');
      }
      const metrics = createUniquePlayerMetrics(await fetchErlcJoinLogs(serverConfig.serverApiKey), range);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(JSON.stringify(metrics));
    } catch (error) {
      console.error('ER:LC player metrics could not be loaded:', error.message);
      return sendText(response, error.statusCode || 502, error.message || 'Could not load ER:LC player metrics.');
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/erlc/session-notifications') {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Sign in before sending session notifications.');

    const origin = request.headers.origin;
    if (origin && origin !== new URL(redirectUri).origin) {
      return sendText(response, 403, 'This setup request did not come from the local ERLY site.');
    }
    const serverConfig = session.erlcServer;
    if (
      !serverConfig?.serverApiKey ||
      serverConfig.ownerDiscordUserId !== session.user.id ||
      !serverConfig.sessionChannelId
    ) {
      return sendText(response, 409, 'Choose a session notification channel before sending a session update.');
    }

    let input;
    try {
      input = await readJsonBody(request);
    } catch (error) {
      return sendText(response, error.statusCode || 400, error.message);
    }
    const notifications = {
      start: {
        title: '# Session Up!',
        text: `- Session has been started by <@${session.user.id}>\n- Make sure to Enjoy the session folks!`
      },
      low: {
        title: '# Session Low!',
        text: `- Session low population was announced by <@${session.user.id}>.\n- Join the server and help fill the session!`
      },
      full: {
        title: '# Session Full!',
        text: `- Session full was announced by <@${session.user.id}>.\n- Please wait until a space is available.`
      },
      shutdown: {
        title: '# Session Shutdown!',
        text: `- Session shutdown was announced by <@${session.user.id}>.\n- Thanks for joining us. Please wait for the next session.`
      }
    };
    const notification = notifications[input?.action];
    if (!notification) return sendText(response, 400, 'Choose a valid session action.');

    const guild = session.guilds?.guilds.find((entry) => entry.id === serverConfig.guildId);
    if (!guild?.canManage) return sendText(response, 403, 'You need server management permission to send session updates.');
    if (guild.botPresent !== true) return sendText(response, 409, 'ERLY must be in this Discord server to send session updates.');

    try {
      const channels = await fetchBotGuildChannels(guild.id);
      if (!channels.some((channel) => channel.id === serverConfig.sessionChannelId)) {
        return sendText(response, 409, 'The saved session channel is no longer available. Choose another channel.');
      }

      const discordResponse = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(serverConfig.sessionChannelId)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bot ' + botToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            flags: 32768,
            allowed_mentions: { parse: [] },
            components: [{
              type: 17,
              accent_color: 0x168a48,
              components: [
                { type: 10, content: notification.title },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: notification.text },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: 'Powered by ERLY' }
              ]
            }]
          })
        }
      );
      const responseBody = await discordResponse.text();

      if (!discordResponse.ok) {
        const error = new Error(
          discordResponse.status === 403
            ? 'ERLY cannot send messages in this channel. Give the bot View Channel and Send Messages permissions.'
            : discordResponse.status === 404
              ? 'The saved session channel no longer exists. Choose another channel.'
              : `Discord could not send the session notification (HTTP ${discordResponse.status}): ${responseBody.slice(0, 200)}`
        );
        error.statusCode = discordResponse.status === 429 ? 503 : discordResponse.status === 403 || discordResponse.status === 404 ? 409 : 502;
        throw error;
      }

      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(JSON.stringify({ sent: true }));
    } catch (error) {
      console.error('Session notification could not be sent:', error.message);
      return sendText(response, error.statusCode || 502, error.message || 'Could not send the session notification.');
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/erlc/configure') {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Sign in with Discord before configuring in-game properties.');

    const origin = request.headers.origin;
    if (origin && origin !== new URL(redirectUri).origin) {
      return sendText(response, 403, 'This setup request did not come from the local ERLY site.');
    }

    if (!session.erlcServer?.serverApiKey) {
      return sendText(response, 409, 'Verify an ER:LC private server before configuring in-game properties.');
    }
    let guild = session.guilds?.guilds.find((entry) => entry.id === session.erlcServer.guildId);
    if (!guild) {
      try {
        const guilds = await fetchUserGuilds(await getValidDiscordAccessToken(session));
        const discordGuild = guilds.find((entry) => entry.id === session.erlcServer.guildId);
        if (discordGuild) guild = { ...discordGuild, canManage: canManageGuild(discordGuild) };
      } catch (error) {
        console.error('Discord server permissions could not be refreshed:', error.message);
        return sendText(response, error.statusCode || 502, error.message || 'Could not verify Discord server permissions.');
      }
    }
    if (!guild?.canManage) return sendText(response, 403, 'You need server management permission to configure ERLY.');

    let input;
    try {
      input = await readJsonBody(request);
    } catch (error) {
      return sendText(response, error.statusCode || 400, error.message);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return sendText(response, 400, 'Request must contain a JSON object.');
    }
    if (
      typeof input.welcomeMessage !== 'string' ||
      input.welcomeMessage.trim().length < 1 ||
      input.welcomeMessage.trim().length > 500 ||
      /[\u0000-\u001f\u007f]/.test(input.welcomeMessage)
    ) {
      return sendText(response, 400, 'Enter a welcome message between 1 and 500 characters without line breaks.');
    }
    if (typeof input.displayName !== 'string') return sendText(response, 400, 'Website server name must be text.');

    const updatedConfig = {
      ...session.erlcServer,
      welcomeMessage: input.welcomeMessage.trim(),
      serverName: input.displayName,
      updatedAt: Date.now()
    };
    try {
      const savedConfig = await persistServerConfig(updatedConfig);
      session.erlcServer = savedConfig;
      startWelcomeMonitor(savedConfig);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(JSON.stringify({ server: publicErlcServer(savedConfig) }));
    } catch (error) {
      console.error('ER:LC configuration could not be saved:', error.message);
      return sendText(response, 500, 'Server details could not be saved. Check the local server logs.');
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/erlc/verify') {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Sign in with Discord before connecting an ER:LC server.');

    const origin = request.headers.origin;
    if (origin && origin !== new URL(redirectUri).origin) {
      return sendText(response, 403, 'This setup request did not come from the local ERLY site.');
    }

    if (!session.guilds || !session.guilds.botConfigured) {
      return sendText(response, 409, 'ERLY bot membership has not been verified yet. Refresh your Discord server list.');
    }

    let input;
    try {
      input = await readJsonBody(request);
    } catch (error) {
      return sendText(response, error.statusCode || 400, error.message);
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return sendText(response, 400, 'Request must contain a JSON object.');
    }
    const guild = session.guilds.guilds.find((entry) => entry.id === input.discordGuildId);
    if (!guild) return sendText(response, 403, 'Choose a Discord server from your server list.');
    if (!guild.canManage) return sendText(response, 403, 'You need Discord server management permission to configure ERLY.');
    if (guild.botPresent !== true) return sendText(response, 409, 'Add the ERLY bot to this Discord server and refresh the list before continuing.');

    if (typeof input.serverApiKey !== 'string' || input.serverApiKey.trim().length < 8 || input.serverApiKey.length > 300) {
      return sendText(response, 400, 'Enter a valid ER:LC private server API key.');
    }

    try {
      const verified = await verifyErlcServer(input.serverApiKey.trim());
      session.pendingErlcServer = {
        guildId: guild.id,
        discordGuildName: guild.name,
        ...verified,
        verifiedAt: Date.now()
      };
      session.pendingErlcApiKey = input.serverApiKey.trim();

      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(JSON.stringify({ ...session.pendingErlcServer }));
    } catch (error) {
      console.error('ER:LC setup verification failed:', error.message);
      return sendText(response, error.statusCode || 502, error.message || 'ER:LC setup verification failed.');
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/erlc/confirm') {
    const session = getSession(request);
    if (!session) return sendText(response, 401, 'Sign in with Discord before connecting an ER:LC server.');

    const origin = request.headers.origin;
    if (origin && origin !== new URL(redirectUri).origin) {
      return sendText(response, 403, 'This setup request did not come from the local ERLY site.');
    }

    let input;
    try {
      input = await readJsonBody(request);
    } catch (error) {
      return sendText(response, error.statusCode || 400, error.message);
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return sendText(response, 400, 'Request must contain a JSON object.');
    }
    const pending = session.pendingErlcServer;
    if (typeof input.confirmed !== 'boolean') {
      return sendText(response, 400, 'Choose whether the verified ER:LC server details are correct.');
    }
    if (!pending || input.discordGuildId !== pending.guildId) {
      return sendText(response, 409, 'Verify the ER:LC server again before confirming it.');
    }

    if (input.confirmed !== true) {
      session.pendingErlcServer = null;
      session.pendingErlcApiKey = null;
      session.erlcServer = null;
      return sendText(response, 200, 'ER:LC setup declined.');
    }

    let previousServer = null;
    try {
      const configs = await loadPersistentConfigs();
      const saved = configs[pending.guildId];
      if (saved?.ownerDiscordUserId === session.user.id) previousServer = saved;
    } catch (error) {
      console.error('Saved ER:LC configuration could not be loaded:', error.message);
      return sendText(response, 500, 'Saved server details could not be loaded. Check the local server logs.');
    }

    const confirmedServer = {
      ...pending,
      erlcServerName: pending.serverName,
      serverApiKey: session.pendingErlcApiKey,
      serverName: previousServer?.serverName ?? pending.serverName,
      welcomeMessage: previousServer?.welcomeMessage ?? '',
      ownerDiscordUserId: session.user.id,
      updatedAt: Date.now()
    };
    try {
      session.erlcServer = await persistServerConfig(confirmedServer);
    } catch (error) {
      console.error('Verified ER:LC server could not be saved:', error.message);
      return sendText(response, 500, 'Verified server details could not be saved. Check the local server logs.');
    }
    session.pendingErlcServer = null;
    session.pendingErlcApiKey = null;
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return response.end(JSON.stringify({ server: publicErlcServer(session.erlcServer) }));
  }

  if (request.method === 'GET' && url.pathname === '/auth/logout') {
    const sessionId = cookieValue(request, 'erly_session');
    if (sessionId) {
      sessions.delete(sessionId);
    }
    clearCookie(response, 'erly_session');
    return redirect(response, '/');
  }

  if (request.method === 'GET' && (url.pathname === '/' || staticFiles.has(url.pathname))) {
    return serveStatic(
      url.pathname === '/' ? '/index.html' : url.pathname,
      request,
      response,
      url.pathname === '/map.html' && url.searchParams.get('preview') === '1'
    );
  }

  return sendText(response, 404, 'Not found.');
});

async function startServer() {
  const configs = await loadPersistentConfigs();
  for (const config of Object.values(configs)) {
    if (config.welcomeMessage && config.serverApiKey) startWelcomeMonitor(config);
  }
  server.listen(port, () => {
    console.log(`ERLY local preview: http://localhost:${port}`);
    console.log(`Discord OAuth callback: ${redirectUri}`);
  });
}

startServer().catch((error) => {
  console.error('ERLY could not load saved server configurations:', error.message);
  process.exitCode = 1;
});
