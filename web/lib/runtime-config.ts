export type RuntimeConfig = {
  apiBaseUrl: string;
  cognitoDomain: string;
  userPoolId: string;
  userPoolClientId: string;
  oauthCallbackUrl: string;
  oauthLogoutUrl: string;
};

export async function loadRuntimeConfig(): Promise<RuntimeConfig | null> {
  try {
    const response = await fetch("/runtime-config.json", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as RuntimeConfig;
  } catch {
    return null;
  }
}
