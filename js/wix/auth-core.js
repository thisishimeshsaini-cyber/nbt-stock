// Declarations of auth-core.ts: what this file exports, their arguments and what they return.
// export type LoginState = "SUCCESS" | "EMAIL_VERIFICATION_REQUIRED" | "OWNER_APPROVAL_REQUIRED" | "FAILURE";
// export interface LoginResult {
//     state: LoginState;
//     stateToken?: string;
//     errorCode?: string;
//     error?: string;
//     redirectUrl?: string;
// }
// export type RawAuth = Record<string, any>;
// export interface AuthOutcome extends LoginResult {
//     sessionToken: string | null;
// }
// export declare function authOutcome(raw: RawAuth | null | undefined): AuthOutcome;
// export declare function toLoginResult({ sessionToken: _consumed, ...result }: AuthOutcome): LoginResult;
// export declare function failure(error: string, errorCode?: string): LoginResult;
// export declare const NO_SESSION_ERROR = "Wix did not return a member session.";
// export declare function fromAuthRoute(status: number, body: RawAuth | null): LoginResult;
// export declare const AUTH_ERROR_CODES: {
//     readonly MISSING_CAPTCHA: "-19971";
//     readonly INVALID_CAPTCHA: "-19970";
//     readonly EMAIL_EXISTS: "-19995";
//     readonly INVALID_PASSWORD: "-19976";
//     readonly RESET_PASSWORD: "-19973";
// };
// export declare function loginErrorCode(code: string | undefined): string;
// export declare function registerErrorCode(code: string | undefined, details?: RawAuth): string | undefined;
// Authentication rules — transport-agnostic, imported by EVERY transport: ./auth.ts (the SDK's
// OAuthStrategy, or the managed-Astro built-in auth routes) and the REST twin in
// templates/members/rest/auth.ts (the IAM authentication API over fetch). What a login/registration
// response MEANS — the four states, when a session token is expected, which Wix error code is which
// failure — lives HERE, once. No imports: a strip to JS emits a plain module.
// REST spells the states differently from the SDK; both map onto LoginState.
const REST_STATES = {
    SUCCESS: "SUCCESS",
    REQUIRE_EMAIL_VERIFICATION: "EMAIL_VERIFICATION_REQUIRED",
    REQUIRE_OWNER_APPROVAL: "OWNER_APPROVAL_REQUIRED",
};
/**
 * Normalize either transport's response — SDK `{ loginState, data: { sessionToken | stateToken },
 * error?, errorCode? }` or REST `{ state, sessionToken?, stateToken? }`. Anything else is a FAILURE.
 */
export function authOutcome(raw) {
    const state = raw?.loginState ?? REST_STATES[raw?.state ?? ""] ?? "FAILURE";
    const stateToken = raw?.stateToken ?? raw?.data?.stateToken;
    return {
        state,
        sessionToken: raw?.data?.sessionToken ?? raw?.sessionToken ?? null,
        ...(stateToken ? { stateToken } : {}),
        ...(raw?.errorCode ? { errorCode: raw.errorCode } : {}),
        ...(raw?.error ? { error: raw.error } : {}),
    };
}
/** The outcome as callers see it — without the session token, which the transport has consumed. */
export function toLoginResult({ sessionToken: _consumed, ...result }) {
    return result;
}
export function failure(error, errorCode) {
    return { state: "FAILURE", error, ...(errorCode ? { errorCode } : {}) };
}
/** A SUCCESS without a session token — the exchange can't run; surfaced as a FAILURE with this text. */
export const NO_SESSION_ERROR = "Wix did not return a member session.";
// The built-in auth routes' request-level error codes (body `{ error }`), in the words a form can show.
const AUTH_ROUTE_ERRORS = {
    ALREADY_LOGGED_IN: "You are already signed in.",
    AUTH_SERVICE_ERROR: "Wix could not process the sign-in right now. Try again.",
    VERIFICATION_FAILED: "That code did not match. Check the email and try again.",
    VERIFICATION_STATE_EXPIRED: "The verification code expired. Sign in again to get a new one.",
    INVALID_REQUEST: "The form sent something Wix did not accept.",
    FORBIDDEN: "This request was refused.",
};
/**
 * A managed-Astro auth route answer → LoginResult. Success: `{ loginState: "SUCCESS", redirectUrl }`
 * (200). Challenges: `{ loginState }` with 403 — verification and owner approval pass through; a
 * CAPTCHA challenge (the site owner turned reCAPTCHA on) is a FAILURE the form cannot clear without
 * a widget. Failure: `{ loginState: "FAILURE", errorCode }` (422, or 403 for resetPassword). Request
 * errors: `{ error: CODE }` without a loginState.
 */
export function fromAuthRoute(status, body) {
    const loginState = body?.loginState;
    switch (loginState) {
        case "SUCCESS":
            return body?.redirectUrl ? { state: "SUCCESS", redirectUrl: body.redirectUrl } : failure(NO_SESSION_ERROR);
        case "EMAIL_VERIFICATION_REQUIRED":
        case "OWNER_APPROVAL_REQUIRED":
            return { state: loginState };
        case "SILENT_CAPTCHA_REQUIRED":
        case "USER_CAPTCHA_REQUIRED":
            return failure("This site requires a CAPTCHA to sign up; the form has no CAPTCHA widget yet.", "captchaRequired");
        case "FAILURE":
            return failure(body?.error ?? FAILURE_TEXT[body?.errorCode ?? ""] ?? "Could not sign in.", body?.errorCode ?? "unknown");
        default: {
            // No route at all: the project's @wix/astro predates the built-in credential routes (2.75).
            if (status === 404 || status === 405)
                return failure("This site's @wix/astro has no /api/auth credential routes; update it to 2.75 or later.", "authRoutesMissing");
            const code = body?.error;
            return failure(AUTH_ROUTE_ERRORS[code ?? ""] ?? `Sign-in request failed (${status}).`, code);
        }
    }
}
/** Default wording per errorCode when the route sends none (the SDK sends none either). */
const FAILURE_TEXT = {
    invalidCredentials: "Wrong email or password.",
    invalidEmail: "That email is not valid here.",
    invalidPassword: "Wrong password.",
    emailAlreadyExists: "An account with this email already exists. Sign in instead.",
    resetPassword: "You need to reset your password before signing in.",
    missingCaptchaToken: "This site requires a CAPTCHA to sign up.",
    invalidCaptchaToken: "The CAPTCHA check failed. Try again.",
};
// Wix IAM application-error codes, named as the SDK names them.
export const AUTH_ERROR_CODES = {
    MISSING_CAPTCHA: "-19971",
    INVALID_CAPTCHA: "-19970",
    EMAIL_EXISTS: "-19995",
    INVALID_PASSWORD: "-19976",
    RESET_PASSWORD: "-19973",
};
/** A failed login's applicationError code → the SDK's errorCode name (anything unrecognized is `invalidEmail`, as the SDK does). */
export function loginErrorCode(code) {
    switch (code) {
        case AUTH_ERROR_CODES.MISSING_CAPTCHA:
            return "missingCaptchaToken";
        case AUTH_ERROR_CODES.INVALID_CAPTCHA:
            return "invalidCaptchaToken";
        case AUTH_ERROR_CODES.INVALID_PASSWORD:
            return "invalidPassword";
        case AUTH_ERROR_CODES.RESET_PASSWORD:
            return "resetPassword";
        default:
            return "invalidEmail";
    }
}
/**
 * A failed registration's applicationError code (+ the response `details`) → the SDK's errorCode
 * name; undefined when the SDK would name none. A validation error on the EMAIL field is `invalidEmail`.
 */
export function registerErrorCode(code, details) {
    const violations = details?.validationError?.fieldViolations ?? [];
    if (violations.some((v) => v?.data?.type === "EMAIL"))
        return "invalidEmail";
    switch (code) {
        case AUTH_ERROR_CODES.MISSING_CAPTCHA:
            return "missingCaptchaToken";
        case AUTH_ERROR_CODES.EMAIL_EXISTS:
            return "emailAlreadyExists";
        case AUTH_ERROR_CODES.INVALID_CAPTCHA:
            return "invalidCaptchaToken";
        default:
            return undefined;
    }
}
