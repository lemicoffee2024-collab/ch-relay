// Google Antigravity (Cloud Code Assist) endpoints and client fingerprint.

/** Public OAuth client id of the Antigravity desktop client (overridable). */
export const CLIENT_ID =
  process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

export const PROD_API = "https://cloudcode-pa.googleapis.com";
export const DAILY_API = "https://daily-cloudcode-pa.googleapis.com";
export const API_VERSION = "v1internal";

export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PORT = 51121;
export const CALLBACK_PATH = "/callback";
export const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

export const IDE_VERSION = "2.5.5";

/**
 * The backend gates newer agent models on the IDE client family: CLI-shaped UAs get 404 for
 * e.g. gemini-3.7/3.8 flash. Mirror the real Antigravity IDE UA.
 */
export function antigravityUserAgent(): string {
  const override = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim();
  if (override) return override;
  return `antigravity/ide/${IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)`;
}

export function apiUrl(base: string, method: string): string {
  return `${base}/${API_VERSION}:${method}`;
}
