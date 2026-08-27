import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getOperatorToken,
  getGatewayToken,
  isGatewayAuthenticated,
  __resetGatewayTokenCache,
  __resetOperatorTokenCache,
  timingSafeEqualStr,
  parseCookies,
  extractPresentedToken,
  isAuthenticated,
  isAllowedOrigin,
  sessionCookie,
  clearSessionCookie,
} from '../src/auth';

// ── Operator-authenticatie (findings #4/#5/#10) ─────────────────────────────
// Pure functies, geen DB/native binding nodig — draaien overal.

const TOKEN = 'super-secret-operator-token';

describe('getOperatorToken', () => {
  beforeEach(() => { __resetOperatorTokenCache(); process.env.HUDDLE_OPERATOR_TOKEN = TOKEN; });
  afterEach(() => { delete process.env.HUDDLE_OPERATOR_TOKEN; __resetOperatorTokenCache(); });

  it('gebruikt HUDDLE_OPERATOR_TOKEN uit de env', () => {
    expect(getOperatorToken()).toBe(TOKEN);
  });
});

describe('timingSafeEqualStr', () => {
  it('true bij gelijk', () => expect(timingSafeEqualStr('abc', 'abc')).toBe(true));
  it('false bij verschil', () => expect(timingSafeEqualStr('abc', 'abd')).toBe(false));
  it('false bij verschillende lengte (geen crash/leak)', () => {
    expect(timingSafeEqualStr('abc', 'abcdef')).toBe(false);
  });
});

describe('parseCookies', () => {
  it('parseert meerdere cookies', () => {
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });
  it('url-decodeert waarden', () => {
    expect(parseCookies('t=a%20b')).toEqual({ t: 'a b' });
  });
  it('lege header → leeg object', () => {
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('extractPresentedToken', () => {
  it('haalt Bearer-token uit de Authorization-header', () => {
    expect(extractPresentedToken({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
  });
  it('haalt token uit de session-cookie', () => {
    expect(extractPresentedToken({ cookie: `huddle_session=${TOKEN}` })).toBe(TOKEN);
  });
  it('Bearer wint van cookie', () => {
    expect(extractPresentedToken({ authorization: 'Bearer aaa', cookie: 'huddle_session=bbb' })).toBe('aaa');
  });
  it('null zonder credential', () => {
    expect(extractPresentedToken({})).toBeNull();
  });
});

describe('isAuthenticated', () => {
  beforeEach(() => { __resetOperatorTokenCache(); process.env.HUDDLE_OPERATOR_TOKEN = TOKEN; });
  afterEach(() => { delete process.env.HUDDLE_OPERATOR_TOKEN; __resetOperatorTokenCache(); });

  it('true met correct Bearer-token', () => {
    expect(isAuthenticated({ authorization: `Bearer ${TOKEN}` })).toBe(true);
  });
  it('true met correcte cookie', () => {
    expect(isAuthenticated({ cookie: `huddle_session=${TOKEN}` })).toBe(true);
  });
  it('false met verkeerd token', () => {
    expect(isAuthenticated({ authorization: 'Bearer wrong' })).toBe(false);
  });
  it('false zonder credential', () => {
    expect(isAuthenticated({})).toBe(false);
  });
});

describe('isAllowedOrigin (CSWSH-verdediging, finding #4)', () => {
  it('geen Origin (niet-browser) → toegestaan (auth-check blijft gelden)', () => {
    expect(isAllowedOrigin(undefined, 'localhost:3000')).toBe(true);
  });
  it('same-origin → toegestaan', () => {
    expect(isAllowedOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
  });
  it('cross-origin (aanvaller-pagina) → geweigerd', () => {
    expect(isAllowedOrigin('https://evil.example.com', 'localhost:3000')).toBe(false);
  });
  it('onparseerbare Origin → geweigerd', () => {
    expect(isAllowedOrigin('not a url', 'localhost:3000')).toBe(false);
  });
});

describe('session cookie flags', () => {
  it('login-cookie is HttpOnly + SameSite=Strict', () => {
    const c = sessionCookie(TOKEN);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain(`huddle_session=${TOKEN}`);
  });
  it('clear-cookie verloopt direct', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});

// ── Gateway-authenticatie voor het control channel ──────────────────────────
// Het gateway-token staat bewust LOS van het operator-token: de gateway mag
// alleen /control/* aanspreken, en het operator-token opent dat juist niet. Een
// gecompromitteerde gateway levert daarmee geen terminal-, exec- of sudo-rechten
// op. Deze tests pinnen die scheiding in beide richtingen vast.

const GW_TOKEN = 'super-secret-gateway-token';

describe('gateway-token', () => {
  beforeEach(() => {
    __resetGatewayTokenCache();
    __resetOperatorTokenCache();
    process.env.HUDDLE_GATEWAY_TOKEN = GW_TOKEN;
    process.env.HUDDLE_OPERATOR_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.HUDDLE_GATEWAY_TOKEN;
    delete process.env.HUDDLE_OPERATOR_TOKEN;
    __resetGatewayTokenCache();
    __resetOperatorTokenCache();
  });

  // `huddle init` LEEST dit bestand om het aan de container mee te geven, dus het
  // moet er al zijn voordat de gateway zijn eerste /control-request doet — die
  // kan hij zonder token immers niet doen. Boot mint het daarom expliciet
  // (boot-node.ts); ontbreekt het, dan sneuvelt init met een kale ENOENT halverwege
  // het aanmaken van de gateway en staat Huddle er half op.
  it('schrijft het token weg als het bestand nog niet bestaat', () => {
    delete process.env.HUDDLE_GATEWAY_TOKEN;
    __resetGatewayTokenCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-gwtoken-'));
    const file = path.join(dir, 'gateway-token');
    process.env.HUDDLE_GATEWAY_TOKEN_FILE = file;
    try {
      expect(fs.existsSync(file)).toBe(false);
      const minted = getGatewayToken();
      expect(minted).toBeTruthy();
      expect(fs.readFileSync(file, 'utf8').trim()).toBe(minted);
    } finally {
      delete process.env.HUDDLE_GATEWAY_TOKEN_FILE;
      __resetGatewayTokenCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gebruikt HUDDLE_GATEWAY_TOKEN uit de env', () => {
    expect(getGatewayToken()).toBe(GW_TOKEN);
  });

  it('is een ander token dan dat van de operator', () => {
    expect(getGatewayToken()).not.toBe(getOperatorToken());
  });

  it('true met correct Bearer-token', () => {
    expect(isGatewayAuthenticated({ authorization: `Bearer ${GW_TOKEN}` })).toBe(true);
  });

  it('het operator-token opent het control channel NIET', () => {
    expect(isGatewayAuthenticated({ authorization: `Bearer ${TOKEN}` })).toBe(false);
  });

  it('het gateway-token opent de operator-API NIET', () => {
    expect(isAuthenticated({ authorization: `Bearer ${GW_TOKEN}` })).toBe(false);
  });

  it('accepteert geen cookie — geen browser hoort hier te komen', () => {
    // Alleen Bearer. Met een cookie zou een pagina die de operator bezoekt de
    // browser tot een control-call kunnen verleiden (zelfde CSRF-redenering als
    // finding #4); een machine-to-machine kanaal heeft cookies niet nodig.
    expect(isGatewayAuthenticated({ cookie: `huddle_session=${encodeURIComponent(GW_TOKEN)}` })).toBe(false);
  });

  it('false zonder credential en bij verkeerd token', () => {
    expect(isGatewayAuthenticated({})).toBe(false);
    expect(isGatewayAuthenticated({ authorization: 'Bearer nope' })).toBe(false);
    expect(isGatewayAuthenticated({ authorization: GW_TOKEN })).toBe(false);
  });
});
