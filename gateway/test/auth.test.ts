import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getOperatorToken,
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
