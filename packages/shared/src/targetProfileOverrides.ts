import type { TargetProfile } from "./schemas/targetProfile.js";

export interface TargetProfileLoginCreds {
  loginUrl: string;
  email: string;
  password: string;
  emailSelector: string;
  passwordSelector: string;
  submitSelector: string;
  nextSelector?: string;
  timeoutMs?: number;
  loginReadyTimeoutMs?: number;
}

export interface TargetProfileOverrides {
  baseUrl: string;
  loginCreds?: TargetProfileLoginCreds;
  allowedDomains: string[];
  charterNav: { locationsPath?: string };
}

function buildLoginCreds(profile: TargetProfile): TargetProfileLoginCreds | undefined {
  const { loginUrl, email, password, emailSelector, passwordSelector, submitSelector } = profile;
  if (!loginUrl || !email || !password || !emailSelector || !passwordSelector || !submitSelector) {
    return undefined;
  }

  return {
    loginUrl,
    email,
    password,
    emailSelector,
    passwordSelector,
    submitSelector,
    nextSelector: profile.nextSelector,
    timeoutMs: profile.timeoutMs,
    loginReadyTimeoutMs: profile.loginReadyTimeoutMs,
  };
}

export function buildTargetProfileOverrides(profile: TargetProfile): TargetProfileOverrides {
  return {
    baseUrl: profile.baseUrl,
    loginCreds: buildLoginCreds(profile),
    allowedDomains: profile.allowedDomains,
    charterNav: { locationsPath: profile.locationsPath },
  };
}
