const fs = require("fs");
const path = require("path");

const WORKDIR = __dirname;
const RECAPTCHA_ACTION = "FREvent";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0";

loadDotEnv(path.join(WORKDIR, ".env"));

const CONFIG = {
  presentationUrl: process.env.PRESENTATION_URL || "",
  url: process.env.WATCH_URL || "",
  apiUrl: process.env.API_URL || "",
  webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  intervalMs: numberEnv("POLL_SECONDS", 180) * 1000,
  blockCooldownMs: numberEnv("BLOCK_COOLDOWN_MINUTES", 180) * 60 * 1000,
  stateFile: path.resolve(WORKDIR, process.env.STATE_FILE || "state.json"),
  sessionFile: path.resolve(WORKDIR, process.env.SESSION_FILE || "session.json"),
  watchedCategories: parseWatchedCategories(process.env.WATCH_CATEGORIES),
  recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || "",
  userAgent: process.env.USER_AGENT || DEFAULT_USER_AGENT,
  secChUa:
    process.env.SEC_CH_UA ||
    '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
  secChUaPlatform: process.env.SEC_CH_UA_PLATFORM || '"Windows"',
  debugBootstrap: truthy(process.env.DEBUG_BOOTSTRAP),
  discordDryRun: truthy(process.env.DISCORD_DRY_RUN),
  notifyOnStart: truthy(process.env.DISCORD_NOTIFY_ON_START),
  runOnce: truthy(process.env.RUN_ONCE),
  event: null,
  ticket: null,
};
const USER_AGENT = CONFIG.userAgent;

async function main() {
  if (truthy(process.env.SELF_TEST)) {
    runSelfTest();
    return;
  }

  if (!CONFIG.webhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL is missing. Add it to .env first.");
  }

  await resolveTicketTarget();
  const client = new TicketClient(CONFIG.url, CONFIG.apiUrl);
  client.loadSession(CONFIG.sessionFile);

  console.log(
    `[watcher] Monitoring ${CONFIG.watchedCategories
      .map((category) => category.label)
      .join(", ")}`
  );
  console.log(`[watcher] Polling every ${CONFIG.intervalMs / 1000}s`);
  console.log(`[watcher] Event: ${CONFIG.event.name || "Unknown event"}`);
  if (CONFIG.presentationUrl) {
    console.log(`[watcher] Presentation URL: ${CONFIG.presentationUrl}`);
  }
  console.log(`[watcher] Ticket URL: ${CONFIG.url}`);
  console.log(`[watcher] API URL: ${CONFIG.apiUrl}`);
  console.log(`[watcher] State file: ${CONFIG.stateFile}`);
  console.log(`[watcher] Session file: ${CONFIG.sessionFile}`);

  while (true) {
    const startedAt = new Date();
    let nextPollMs = CONFIG.intervalMs;
    try {
      const current = await fetchAvailabilitySnapshot(client);
      const previous = readJson(CONFIG.stateFile);
      const previousMatchesEvent =
        previous && getEventFingerprint(previous.event) === getEventFingerprint(current.event);
      if (previous && !previousMatchesEvent) {
        console.log(
          `[watcher] Event changed (${getEventFingerprint(previous.event)} -> ${getEventFingerprint(
            current.event
          )}); resetting saved availability baseline.`
        );
      }
      const baseline = previousMatchesEvent ? previous : null;
      const changes = baseline ? compareSnapshots(baseline, current) : [];

      if (!baseline && CONFIG.notifyOnStart) {
        await sendDiscordMessage(formatStartupMessage(current));
      } else if (baseline && changes.length > 0) {
        await sendDiscordMessage(formatChangeMessage(baseline, current, changes));
      }

      writeJson(CONFIG.stateFile, current);
      client.saveSession(CONFIG.sessionFile);

      const delta = baseline ? current.totalAvailable - baseline.totalAvailable : 0;
      const sign = delta > 0 ? "+" : "";
      console.log(
        `[${startedAt.toISOString()}] ${formatConsoleSummary(current)} (${sign}${delta})`
      );
    } catch (error) {
      console.error(`[${startedAt.toISOString()}] poll failed: ${error.message}`);
      if (error instanceof TicketingBlockError) {
        nextPollMs = CONFIG.blockCooldownMs;
        console.error(
          `[watcher] Ticketing site returned an anti-bot block. Cooling down for ${Math.round(
            nextPollMs / 60000
          )} minutes.`
        );
      }
    }

    if (CONFIG.runOnce) break;
    await sleep(nextPollMs);
  }
}

class TicketClient {
  constructor(pageUrl, apiUrl) {
    this.pageUrl = pageUrl;
    this.apiUrl = apiUrl;
    this.origin = new URL(pageUrl).origin;
    this.host = new URL(pageUrl).hostname;
    this.cookies = {};
    this.recaptchaSiteKey = CONFIG.recaptchaSiteKey;
  }

  loadSession(filePath) {
    const session = readJson(filePath);
    if (session && session.cookies) {
      this.cookies = session.cookies;
    }
  }

  saveSession(filePath) {
    writeJson(filePath, {
      savedAt: new Date().toISOString(),
      cookies: this.cookies,
    });
  }

  async fetchTariff() {
    let response = await this.request(this.apiUrl, {
      headers: apiHeaders(this.pageUrl),
    });

    if (response.status === 403 || response.status === 401) {
      debugLog(`ticket API pre-bootstrap returned ${response.status}`);
      await this.bootstrapSession();
      debugLog(`cookies after bootstrap: ${this.cookieSummary()}`);
      response = await this.request(this.apiUrl, {
        headers: apiHeaders(this.pageUrl),
      });
      debugLog(`ticket API post-bootstrap returned ${response.status}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (isTicketingBlock(response.status, body)) {
        throw new TicketingBlockError(response.status, body);
      }
      throw new Error(`ticket API failed: ${response.status} ${body.slice(0, 200)}`);
    }

    return response.json();
  }

  async bootstrapSession() {
    const firstPage = await this.request(this.pageUrl, {
      headers: pageHeaders(),
    });
    debugLog(`initial page returned ${firstPage.status}; cookies: ${this.cookieSummary()}`);

    const epsManager = await this.requestText(`${this.origin}/eps-mgr`, {
      headers: {
        accept: "*/*",
        referer: this.pageUrl,
        "sec-fetch-dest": "script",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-site": "same-origin",
      },
    });
    debugLog(`eps-mgr loaded; cookies: ${this.cookieSummary()}`);

    if (!this.recaptchaSiteKey) {
      this.recaptchaSiteKey = await discoverRecaptchaSiteKey(this.origin, epsManager);
    }
    debugLog(`recaptcha site key: ${this.recaptchaSiteKey.slice(0, 8)}...`);

    const token = await getRecaptchaToken(this.origin, this.recaptchaSiteKey);
    debugLog(`recaptcha token length: ${token.length}`);
    const gecResponse = await this.request(`${this.origin}/epsf/gec/v3/${RECAPTCHA_ACTION}`, {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        origin: this.origin,
        referer: this.pageUrl,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        hostname: this.host,
        key: this.recaptchaSiteKey,
        token,
      }),
    });
    debugLog(`gec returned ${gecResponse.status}; cookies: ${this.cookieSummary()}`);

    const finalPage = await this.request(this.pageUrl, {
      headers: pageHeaders(),
    });

    if (!finalPage.ok) {
      console.warn(
        `[watcher] Session bootstrap final page returned ${finalPage.status}; trying ticket API anyway.`
      );
    }
    debugLog(`final page returned ${finalPage.status}; cookies: ${this.cookieSummary()}`);
  }

  async request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "user-agent": USER_AGENT,
        "accept-language": "fr-FR,fr;q=0.9",
        cookie: this.cookieHeader(),
        ...options.headers,
      },
    });

    this.storeCookies(response);
    return response;
  }

  async requestText(url, options = {}) {
    const response = await this.request(url, options);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`request failed: ${response.status} ${url} ${body.slice(0, 200)}`);
    }
    return response.text();
  }

  storeCookies(response) {
    const setCookies = getSetCookies(response);
    for (const cookie of setCookies) {
      const [nameValue] = cookie.split(";");
      const separator = nameValue.indexOf("=");
      if (separator <= 0) continue;

      const name = nameValue.slice(0, separator);
      const value = nameValue.slice(separator + 1);
      this.cookies[name] = value;
    }
  }

  cookieHeader() {
    return Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  cookieSummary() {
    const names = ["eps_sid", "tmpt", "SID", "BID", "tkm_i18n"];
    return names
      .map((name) => `${name}=${this.cookies[name] ? "yes" : "no"}`)
      .join(", ");
  }
}

class TicketingBlockError extends Error {
  constructor(status, body) {
    super(`ticket API anti-bot block: ${status} ${String(body).slice(0, 200)}`);
    this.name = "TicketingBlockError";
    this.status = status;
  }
}

function isTicketingBlock(status, body) {
  return status === 403 && /"response"\s*:\s*"block"|robot|suspendue/i.test(String(body));
}

async function discoverRecaptchaSiteKey(origin, epsManagerScript) {
  const epsfBase =
    epsManagerScript.match(/window\.epsfBase='([^']+)'/)?.[1] ||
    epsManagerScript.match(/window\.epsfBase="([^"]+)"/)?.[1] ||
    "/epsf";
  const epsGecUrl = `${origin}${epsfBase}/asset/eps-gec.js`;
  const response = await fetch(epsGecUrl, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/javascript,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`EPS GEC asset failed: ${response.status}`);
  }

  const script = await response.text();
  const key =
    script.match(/const key = "([^"]+)"/)?.[1] ||
    script.match(/const key='([^']+)'/)?.[1] ||
    script.match(/render=([^"'&]+)/)?.[1];

  if (!key) {
    throw new Error("Could not discover reCAPTCHA site key from EPS GEC asset.");
  }

  return key;
}

async function getRecaptchaToken(origin, siteKey) {
  const recaptchaOrigin = `${new URL(origin).origin}:443`;
  const encodedOrigin = Buffer.from(recaptchaOrigin)
    .toString("base64")
    .replace(/=/g, ".");
  const anchorUrl =
    "https://www.google.com/recaptcha/enterprise/anchor" +
    `?ar=1&k=${encodeURIComponent(siteKey)}` +
    `&co=${encodeURIComponent(encodedOrigin)}` +
    "&hl=fr&v=&size=invisible" +
    `&sa=${encodeURIComponent(RECAPTCHA_ACTION)}` +
    `&cb=${Math.random().toString(36).slice(2)}`;

  const anchorResponse = await fetch(anchorUrl, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!anchorResponse.ok) {
    throw new Error(`reCAPTCHA anchor failed: ${anchorResponse.status}`);
  }

  const anchorHtml = await anchorResponse.text();
  const version =
    anchorHtml.match(/\/recaptcha\/releases\/([^/]+)\//)?.[1] || "";
  const challengeToken = anchorHtml.match(/id="recaptcha-token" value="([^"]+)"/)?.[1];
  if (!challengeToken) {
    throw new Error("reCAPTCHA anchor token was not found.");
  }

  const reloadBody = new URLSearchParams({
    v: version,
    reason: "q",
    c: challengeToken,
    k: siteKey,
    co: encodedOrigin,
    sa: RECAPTCHA_ACTION,
  });

  const reloadResponse = await fetch(
    `https://www.google.com/recaptcha/enterprise/reload?k=${encodeURIComponent(
      siteKey
    )}`,
    {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        "content-type": "application/x-www-form-urlencoded",
        referer: anchorUrl,
      },
      body: reloadBody,
    }
  );

  if (!reloadResponse.ok) {
    throw new Error(`reCAPTCHA reload failed: ${reloadResponse.status}`);
  }

  const reloadText = await reloadResponse.text();
  const token = reloadText.match(/\["rresp","([^"]+)"/)?.[1];
  if (!token) {
    throw new Error("reCAPTCHA response token was not found.");
  }

  return token;
}

async function fetchAvailabilitySnapshot(client) {
  const payload = await client.fetchTariff();
  const categories = findWatchedCategories(payload);

  if (categories.length === 0) {
    throw new Error("Could not find any watched categories in tariff response.");
  }

  const snapshotCategories = categories.map(buildCategorySnapshot);
  const event = buildEventSnapshot(payload);
  return {
    checkedAt: new Date().toISOString(),
    event,
    eventFingerprint: getEventFingerprint(event),
    totalAvailable: sum(snapshotCategories.map((category) => category.total)),
    categories: snapshotCategories,
  };
}

async function resolveTicketTarget() {
  if (!CONFIG.url && CONFIG.presentationUrl) {
    const discovered = await discoverTicketTarget(CONFIG.presentationUrl);
    CONFIG.url = discovered.ticketUrl;
    CONFIG.event = discovered.event;
  }

  if (!CONFIG.url) {
    throw new Error("Set PRESENTATION_URL or WATCH_URL in .env.");
  }

  CONFIG.ticket = parseTicketUrl(CONFIG.url);
  CONFIG.event = {
    ...(CONFIG.event || {}),
    presentationUrl: CONFIG.presentationUrl || "",
    ticketUrl: CONFIG.url,
    idmanif: CONFIG.ticket.idmanif,
    idseance: CONFIG.ticket.idseance,
  };

  if (!CONFIG.apiUrl) {
    CONFIG.apiUrl = await buildTariffApiUrl(CONFIG.url, CONFIG.ticket);
  }

  CONFIG.event.apiUrl = CONFIG.apiUrl;
}

async function discoverTicketTarget(presentationUrl) {
  const response = await fetch(presentationUrl, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`presentation page failed: ${response.status}`);
  }

  const html = await response.text();
  const links = extractTicketLinks(html);
  const ticketUrl =
    links.find((link) => link.includes("/idseance/") && !link.includes("/priority-")) ||
    links.find((link) => !link.includes("/priority-")) ||
    links[0];

  if (!ticketUrl) {
    throw new Error("Could not find a billetterie manifestation URL on presentation page.");
  }

  return {
    ticketUrl,
    event: extractPresentationEventInfo(html, presentationUrl),
  };
}

function extractTicketLinks(html) {
  const normalizedHtml = html
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  const matches = normalizedHtml.matchAll(
    /https?:\/\/billetterie\.arkeaarena\.com\/fr\/manifestation\/[^"'<>\\\s]+/g
  );

  return [...new Set([...matches].map((match) => cleanUrl(match[0])))]
    .filter((url) => url.includes("/idmanif/"))
    .sort((a, b) => scoreTicketUrl(b) - scoreTicketUrl(a));
}

function cleanUrl(url) {
  return url.replace(/[\\),.;\]]+$/g, "");
}

function scoreTicketUrl(url) {
  let score = 0;
  if (url.includes("/idseance/")) score += 10;
  if (!url.includes("/priority-")) score += 5;
  if (url.includes("/codtypadh/")) score += 3;
  if (url.includes("/codeconf/")) score += 3;
  if (url.includes("-billet/")) score += 1;
  return score;
}

async function buildTariffApiUrl(ticketUrl, parsedTicket) {
  const ticket = parsedTicket || parseTicketUrl(ticketUrl);
  const origin = new URL(ticketUrl).origin;
  const partnerId = await fetchPartnerId(origin, ticketUrl);
  const params = new URLSearchParams({
    codLang: "FR",
    codtypadh: ticket.codtypadh || "PRM",
    codCoMod: "WEB",
  });

  if (ticket.codeconf) params.set("codeconf", ticket.codeconf);
  if (ticket.numadh) params.set("numadh", ticket.numadh);

  return (
    `${origin}/api/grille-tarifaire/manifestation/idmanif/${ticket.idmanif}` +
    `/seance/idseance/${ticket.idseance}/${partnerId}?${params.toString()}`
  );
}

async function fetchPartnerId(origin, referer) {
  const response = await fetch(`${origin}/api/partners/url`, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/plain,application/json,*/*",
      referer,
    },
  });

  if (!response.ok) {
    throw new Error(`partner id lookup failed: ${response.status}`);
  }

  const partnerId = (await response.text()).trim();
  if (!/^\d+$/.test(partnerId)) {
    throw new Error(`partner id lookup returned unexpected value: ${partnerId}`);
  }

  return partnerId;
}

function parseTicketUrl(ticketUrl) {
  const path = new URL(ticketUrl).pathname;
  const values = {};
  for (const key of ["idmanif", "idseance", "codtypadh", "numadh", "codeconf"]) {
    const match = path.match(new RegExp(`/${key}/([^/]+)`));
    if (match) values[key] = decodeURIComponent(match[1]);
  }

  if (!values.idmanif) {
    throw new Error(`ticket URL is missing idmanif: ${ticketUrl}`);
  }

  if (!values.idseance) {
    throw new Error(`ticket URL is missing idseance: ${ticketUrl}`);
  }

  return values;
}

function extractPresentationEventInfo(html, presentationUrl) {
  const normalizedHtml = html
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  const markdownTitle = normalizedHtml.match(/# ([^\n]+)\nPage :/)?.[1];
  const pageTitle =
    normalizedHtml.match(/<title>([^<]+)<\/title>/i)?.[1] ||
    normalizedHtml.match(/"title":"([^"]+)"/)?.[1];

  return compactObject({
    name: cleanText(markdownTitle || pageTitle || ""),
    presentationUrl,
    dates: cleanText(normalizedHtml.match(/Dates : ([^\n]+)/)?.[1] || ""),
    genre: cleanText(normalizedHtml.match(/Genre : ([^\n]+)/)?.[1] || ""),
    duration: cleanText(normalizedHtml.match(/Durée approximative : ([^\n]+)/)?.[1] || ""),
    organizer: cleanText(normalizedHtml.match(/Organisateur : ([^\n]+)/)?.[1] || ""),
  });
}

function buildEventSnapshot(payload) {
  const apiEvent = compactObject({
    name: cleanText(payload.llgseanc || payload.nameManif || ""),
    date: payload.dateSeance || "",
    idmanif: payload.idmanif,
    idseance: payload.idseanc,
    hasPlacesDispo: payload.hasPlacesDispo,
    status: payload.status,
    presentationUrl: CONFIG.event?.presentationUrl || "",
    ticketUrl: CONFIG.url,
    apiUrl: CONFIG.apiUrl,
  });

  return compactObject({
    ...(CONFIG.event || {}),
    ...apiEvent,
    name: CONFIG.event?.name || apiEvent.name || "",
  });
}

function findWatchedCategories(payload) {
  const categories =
    payload && Array.isArray(payload.infoCategories) ? payload.infoCategories : [];

  return CONFIG.watchedCategories
    .map((watched) => {
      const category = categories.find((candidate) => categoryMatches(candidate, watched));
      if (!category) {
        console.warn(`[watcher] Missing category in API response: ${watched.label}`);
      }
      return category;
    })
    .filter(Boolean);
}

function categoryMatches(candidate, watched) {
  const codeMatches = watched.code && String(candidate.codCatPl || "") === watched.code;
  const longNameMatches =
    watched.name && normalize(candidate.llgCatPl) === normalize(watched.name);
  const shortNameMatches =
    watched.shortName && normalize(candidate.llcCatPl) === normalize(watched.shortName);
  return codeMatches || longNameMatches || shortNameMatches;
}

function buildCategorySnapshot(category) {
  const zones = (category.zones || [])
    .map((zone) => ({
      id: String(zone.idzone || zone.llczone || "unknown"),
      name: String(zone.llczone || zone.idzone || "unknown"),
      available: Number(zone.nbplaces || 0),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  return {
    code: String(category.codCatPl || ""),
    shortLabel: String(category.llcCatPl || ""),
    label: String(category.llgCatPl || category.llcCatPl || "UNKNOWN"),
    total: Number(category.nbPlaces || 0),
    priceMin: Number(category.priceMin || 0),
    zones,
  };
}

function compareSnapshots(previous, current) {
  const changes = [];
  const currentCategories = new Map(
    current.categories.map((category) => [categoryKey(category), category])
  );

  if (current.totalAvailable < previous.totalAvailable) {
    changes.push({
      type: "total_drop",
      message: `${previous.totalAvailable - current.totalAvailable} watched ticket(s) disappeared overall (${previous.totalAvailable} -> ${current.totalAvailable}).`,
    });
  } else if (current.totalAvailable > previous.totalAvailable) {
    changes.push({
      type: "total_rise",
      message: `${current.totalAvailable - previous.totalAvailable} watched ticket(s) came back overall (${previous.totalAvailable} -> ${current.totalAvailable}).`,
    });
  }

  for (const previousCategory of previous.categories || []) {
    const currentCategory = currentCategories.get(categoryKey(previousCategory));
    if (!currentCategory && previousCategory.total > 0) {
      changes.push({
        type: "category_missing",
        message: `${previousCategory.label} disappeared (${previousCategory.total} were available).`,
      });
      continue;
    }

    if (!currentCategory) continue;

    if (currentCategory.total < previousCategory.total) {
      changes.push({
        type: "category_drop",
        message: `${currentCategory.label}: ${previousCategory.total - currentCategory.total} ticket(s) disappeared (${previousCategory.total} -> ${currentCategory.total}).`,
      });
    } else if (currentCategory.total > previousCategory.total) {
      changes.push({
        type: "category_rise",
        message: `${currentCategory.label}: ${currentCategory.total - previousCategory.total} ticket(s) came back (${previousCategory.total} -> ${currentCategory.total}).`,
      });
    }

    const currentZones = new Map(currentCategory.zones.map((zone) => [zone.id, zone]));
    for (const previousZone of previousCategory.zones || []) {
      const currentZone = currentZones.get(previousZone.id);

      if (!currentZone && previousZone.available > 0) {
        changes.push({
          type: "zone_missing",
          message: `${previousCategory.label} zone ${previousZone.name} disappeared (${previousZone.available} were available).`,
        });
        continue;
      }

      if (currentZone && currentZone.available < previousZone.available) {
        changes.push({
          type: "zone_drop",
          message: `${previousCategory.label} zone ${previousZone.name}: ${previousZone.available - currentZone.available} ticket(s) disappeared (${previousZone.available} -> ${currentZone.available}).`,
        });
      } else if (currentZone && currentZone.available > previousZone.available) {
        changes.push({
          type: "zone_rise",
          message: `${previousCategory.label} zone ${previousZone.name}: ${currentZone.available - previousZone.available} ticket(s) came back (${previousZone.available} -> ${currentZone.available}).`,
        });
      }
    }

    const previousZones = new Set((previousCategory.zones || []).map((zone) => zone.id));
    for (const currentZone of currentCategory.zones || []) {
      if (!previousZones.has(currentZone.id) && currentZone.available > 0) {
        changes.push({
          type: "zone_added",
          message: `${currentCategory.label} zone ${currentZone.name} appeared (${currentZone.available} available).`,
        });
      }
    }
  }

  return changes;
}

function formatChangeMessage(previous, current, changes) {
  const eventName = getEventName(current);
  return [
    `**${eventName} availability changed**`,
    "",
    ...changes.map((change) => `- ${change.message}`),
    "",
    `Total watched now: **${current.totalAvailable}** available`,
    "",
    ...current.categories.map(
      (category) => `- ${category.label}: **${category.total}** available`
    ),
    "",
    `Previous check: ${previous.checkedAt}`,
    `Current check: ${current.checkedAt}`,
    current.event.ticketUrl || CONFIG.url,
  ].join("\n");
}

function formatStartupMessage(current) {
  const eventName = getEventName(current);
  return [
    `**${eventName} watcher started**`,
    `Total watched availability: **${current.totalAvailable}** tickets.`,
    "",
    ...current.categories.map(
      (category) => `- ${category.label}: **${category.total}** available`
    ),
    current.event.ticketUrl || CONFIG.url,
  ].join("\n");
}

async function sendDiscordMessage(content) {
  if (CONFIG.discordDryRun) {
    console.log(`[watcher] DISCORD_DRY_RUN=1; would send Discord message:\n${content}`);
    return;
  }

  const response = await fetch(CONFIG.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${response.status} ${body}`);
  }
}

function apiHeaders(referer) {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    referer,
    "sec-ch-ua": CONFIG.secChUa,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": CONFIG.secChUaPlatform,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
}

function pageHeaders() {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "upgrade-insecure-requests": "1",
  };
}

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const cookie = response.headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseWatchedCategories(value) {
  const defaults = [
    { code: "01", name: "CATEGORIE 1", shortName: "CAT1", label: "CATEGORIE 1" },
    { code: "02", name: "CATEGORIE 2", shortName: "CAT2", label: "CATEGORIE 2" },
    { code: "FO", name: "FOSSE", shortName: "FOSSE", label: "FOSSE" },
  ];

  if (!value) return defaults;

  const wanted = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalize);

  return defaults.filter((category) => {
    return wanted.some(
      (item) =>
        item === normalize(category.code) ||
        item === normalize(category.name) ||
        item === normalize(category.shortName)
    );
  });
}

function categoryKey(category) {
  return category.code || normalize(category.label);
}

function formatConsoleSummary(snapshot) {
  const eventName = getEventName(snapshot);
  const categories = snapshot.categories
    .map((category) => `${category.label}: ${category.total}`)
    .join(" | ");
  return `${eventName} | ${categories}`;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function getEventName(snapshot) {
  return cleanText(snapshot.event?.name || CONFIG.event?.name || "Arkea Arena event");
}

function getEventFingerprint(event = {}) {
  if (event.idmanif && event.idseance) {
    return `${event.idmanif}:${event.idseance}`;
  }
  if (event.ticketUrl) return event.ticketUrl;
  if (event.presentationUrl) return event.presentationUrl;
  return "unknown-event";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== "" && value !== null && value !== undefined)
  );
}

function debugLog(message) {
  if (CONFIG.debugBootstrap) {
    console.log(`[watcher:debug] ${message}`);
  }
}

function truthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(String(value || "").toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSelfTest() {
  const previous = {
    checkedAt: "previous",
    event: { name: "Test event", ticketUrl: "https://example.test/tickets" },
    totalAvailable: 10,
    categories: [
      {
        code: "01",
        label: "CATEGORIE 1",
        total: 10,
        zones: [{ id: "zone-a", name: "A", available: 10 }],
      },
    ],
  };
  const current = {
    checkedAt: "current",
    event: previous.event,
    totalAvailable: 11,
    categories: [
      {
        code: "01",
        label: "CATEGORIE 1",
        total: 11,
        zones: [{ id: "zone-a", name: "A", available: 11 }],
      },
    ],
  };

  const changes = compareSnapshots(previous, current);
  if (!changes.some((change) => change.type === "total_rise")) {
    throw new Error("SELF_TEST failed: total_rise was not detected.");
  }
  if (!changes.some((change) => change.type === "category_rise")) {
    throw new Error("SELF_TEST failed: category_rise was not detected.");
  }
  if (!changes.some((change) => change.type === "zone_rise")) {
    throw new Error("SELF_TEST failed: zone_rise was not detected.");
  }

  console.log(formatChangeMessage(previous, current, changes));
}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exit(1);
});
