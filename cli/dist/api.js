"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.del = exports.put = exports.post = exports.get = exports.ApiError = void 0;
exports.setBaseUrl = setBaseUrl;
exports.apiCall = apiCall;
let baseUrl = normalizeBaseUrl(process.env.HUDDLE_URL ?? 'http://localhost:3000');
class ApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'ApiError';
    }
}
exports.ApiError = ApiError;
function setBaseUrl(url) {
    baseUrl = normalizeBaseUrl(url);
}
async function apiCall(method, path, body) {
    let res;
    try {
        res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: body !== undefined ? { 'content-type': 'application/json' } : {},
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ApiError(`Kan Huddle API niet bereiken op ${baseUrl}: ${detail}`);
    }
    const raw = await res.text();
    const payload = parsePayload(raw);
    if (!res.ok) {
        const msg = errorMessage(payload) ?? res.statusText;
        throw new ApiError(`${method} ${path} -> ${res.status}: ${msg}`, res.status);
    }
    return payload;
}
const get = (path) => apiCall('GET', path);
exports.get = get;
const post = (path, body) => apiCall('POST', path, body);
exports.post = post;
const put = (path, body) => apiCall('PUT', path, body);
exports.put = put;
const del = (path) => apiCall('DELETE', path);
exports.del = del;
function normalizeBaseUrl(url) {
    const trimmed = url.trim();
    if (!trimmed)
        throw new Error('Huddle URL mag niet leeg zijn');
    return trimmed.replace(/\/+$/, '');
}
function parsePayload(raw) {
    if (!raw)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
function errorMessage(payload) {
    if (!payload || typeof payload !== 'object')
        return typeof payload === 'string' ? payload : undefined;
    const obj = payload;
    if (typeof obj.message === 'string')
        return obj.message;
    if (typeof obj.error === 'string')
        return obj.error;
    return undefined;
}
