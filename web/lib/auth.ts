import { RuntimeConfig } from "@/lib/runtime-config";

const TOKEN_KEY = "ff-game-auth-v1";

type TokenSet = {
  access_token: string;
  id_token?: string;
  expires_in?: number;
  expires_at?: number;
};

export function getTokens(): TokenSet | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  const tokens = JSON.parse(raw) as TokenSet;
  if (isExpired(tokens)) {
    clearTokens();
    return null;
  }
  return tokens;
}

export function saveTokens(tokens: TokenSet) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(withExpiry(tokens)));
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function beginLogin(config: RuntimeConfig) {
  const verifier = randomString(64);
  const challenge = await sha256Base64Url(verifier);
  sessionStorage.setItem("ff-pkce-verifier", verifier);
  const params = new URLSearchParams({
    client_id: config.userPoolClientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: config.oauthCallbackUrl,
    code_challenge_method: "S256",
    code_challenge: challenge,
    identity_provider: "Google",
  });
  window.location.href = `${config.cognitoDomain}/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCode(config: RuntimeConfig, code: string): Promise<TokenSet> {
  const verifier = sessionStorage.getItem("ff-pkce-verifier") ?? "";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.userPoolClientId,
    code,
    redirect_uri: config.oauthCallbackUrl,
    code_verifier: verifier,
  });
  const response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("Failed to exchange Cognito code");
  const tokens = (await response.json()) as TokenSet;
  saveTokens(tokens);
  return tokens;
}

export function logout(config: RuntimeConfig) {
  clearTokens();
  const params = new URLSearchParams({
    client_id: config.userPoolClientId,
    logout_uri: config.oauthLogoutUrl,
  });
  window.location.href = `${config.cognitoDomain}/logout?${params.toString()}`;
}

function withExpiry(tokens: TokenSet): TokenSet {
  if (tokens.expires_at) return tokens;
  if (tokens.expires_in) return { ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 };
  const jwtExpiry = jwtExpiresAt(tokens.access_token);
  return jwtExpiry ? { ...tokens, expires_at: jwtExpiry } : tokens;
}

function isExpired(tokens: TokenSet) {
  const expiresAt = tokens.expires_at ?? jwtExpiresAt(tokens.access_token);
  if (!expiresAt) return false;
  return Date.now() >= expiresAt - 30_000;
}

function jwtExpiresAt(token: string) {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/gu, "+").replace(/_/gu, "/");
    const decoded = JSON.parse(atob(normalized)) as { exp?: number };
    return decoded.exp ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}
