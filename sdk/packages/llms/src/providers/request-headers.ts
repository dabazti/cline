import { decodeJwtPayload } from "@cline/shared";

export interface ProviderRequestHeaderClientContext {
	name?: string;
	version?: string;
	versionHeaderFallback?: string;
	platform?: string;
	platformVersion?: string;
	isMultiRoot?: boolean;
}

export interface ProviderRequestHeaderLayers {
	stored?: Record<string, string>;
	config?: Record<string, string>;
	session?: Record<string, string>;
}

export interface OpenAICodexRequestHeaderContext {
	accountId?: string;
	accessToken?: string;
	userAgentVersion?: string;
}

export interface ResolveProviderRequestHeadersInput {
	providerId: string;
	/**
	 * Session (task) id the request belongs to, surfaced as `X-Task-ID` for
	 * Cline billing providers and `session_id` for OpenAI Codex.
	 *
	 * Optional because not every request is part of a session: standalone
	 * one-shot utility calls (e.g. VS Code commit message generation) have no
	 * task. When omitted, `X-Task-ID` is left off entirely rather than sent
	 * empty — the pre-SDK extension sent `X-Task-ID: ""` from that same
	 * commit-message path, so no Cline surface depends on a meaningful id here.
	 */
	sessionId?: string;
	/** Optional task-scoped header for OpenAI-compatible providers. */
	sessionIdHeader?: { enabled: boolean; name: string };
	source?: string;
	defaultSource: string;
	client?: ProviderRequestHeaderClientContext;
	coreVersion: string;
	openAiCodex?: OpenAICodexRequestHeaderContext;
	headers?: ProviderRequestHeaderLayers;
}

const RESERVED_SESSION_HEADER_NAMES = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"upgrade",
	"keep-alive",
	"te",
	"trailer",
	"proxy-connection",
	"origin",
	"referer",
	"user-agent",
	"accept",
	"accept-encoding",
	"accept-language",
	"content-type",
	"content-encoding",
	"access-control-request-headers",
	"access-control-request-method",
	"access-control-allow-origin",
	"cookie2",
	"date",
	"dnt",
	"expect",
	"max-forwards",
	"via",
	"permissions-policy",
	"x-http-method",
	"x-http-method-override",
	"x-method-override",
	"sec-websocket-key",
	"sec-websocket-version",
	"sec-websocket-protocol",
	"sec-websocket-extensions",
]);

function buildSessionIdHeader(
	input: ResolveProviderRequestHeadersInput,
): Record<string, string> | undefined {
	const setting = input.sessionIdHeader;
	const sessionId = trimNonEmpty(input.sessionId);
	if (
		input.providerId !== "openai-compatible" ||
		!setting?.enabled ||
		!sessionId ||
		!/^[\x20-\x7e\t]+$/.test(sessionId)
	)
		return undefined;
	const name = setting.name.trim();
	const lowerName = name.toLowerCase();
	if (
		!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
		RESERVED_SESSION_HEADER_NAMES.has(lowerName) ||
		lowerName.startsWith("proxy-") ||
		lowerName.startsWith("sec-") ||
		lowerName.startsWith("access-control-")
	)
		return undefined;
	return { [name]: sessionId };
}

function mergeSessionIdHeader(
	headers: Record<string, string> | undefined,
	input: ResolveProviderRequestHeadersInput,
): Record<string, string> | undefined {
	const dynamic = buildSessionIdHeader(input);
	if (!dynamic) return headers ? { ...headers } : undefined;
	const name = Object.keys(dynamic)[0];
	const withoutConflict = Object.fromEntries(
		Object.entries(headers ?? {}).filter(
			([key]) => key.toLowerCase() !== name.toLowerCase(),
		),
	);
	return { ...withoutConflict, [name]: dynamic[name] };
}

export const DEFAULT_CLINE_REQUEST_HEADERS: Record<string, string> = {
	"HTTP-Referer": "https://cline.bot",
	"X-Title": "Cline",
	"X-IS-MULTIROOT": "false",
	"X-CLIENT-TYPE": "cline-sdk",
};

function isClineBillingProvider(providerId: string): boolean {
	return providerId === "cline" || providerId === "cline-pass";
}

function trimNonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveSource(
	source: string | undefined,
	defaultSource: string,
): string {
	return trimNonEmpty(source) ?? defaultSource;
}

function resolveClineClientVersion(
	client: ProviderRequestHeaderClientContext | undefined,
): string {
	return (
		trimNonEmpty(client?.version) ??
		trimNonEmpty(client?.versionHeaderFallback) ??
		"unknown"
	);
}

function buildClineRequestHeaders(
	input: ResolveProviderRequestHeadersInput,
): Record<string, string> | undefined {
	if (!isClineBillingProvider(input.providerId)) {
		return undefined;
	}
	const source = resolveSource(input.source, input.defaultSource);
	const clientType = trimNonEmpty(input.client?.name) ?? `cline-${source}`;
	const clientVersion = resolveClineClientVersion(input.client);
	const platform = trimNonEmpty(input.client?.platform) ?? source;
	const platformVersion =
		trimNonEmpty(input.client?.platformVersion) ?? clientVersion;
	const sessionId = trimNonEmpty(input.sessionId);
	return {
		...DEFAULT_CLINE_REQUEST_HEADERS,
		"User-Agent": `Cline/${clientVersion}`,
		"X-IS-MULTIROOT": input.client?.isMultiRoot === true ? "true" : "false",
		"X-CLIENT-TYPE": clientType,
		"X-CLIENT-VERSION": clientVersion,
		"X-PLATFORM": platform,
		"X-PLATFORM-VERSION": platformVersion,
		"X-CORE-VERSION": input.coreVersion,
		...(sessionId ? { "X-Task-ID": sessionId } : {}),
	};
}

function deriveOpenAICodexAccountId(
	accessToken: string | undefined,
): string | undefined {
	const payload = decodeJwtPayload(accessToken) as
		| {
				"https://api.openai.com/auth"?: { chatgpt_account_id?: string };
				organizations?: Array<{ id?: string }>;
				chatgpt_account_id?: string;
		  }
		| undefined;
	const authAccountId =
		payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	if (typeof authAccountId === "string" && authAccountId.length > 0) {
		return authAccountId;
	}
	const orgAccountId = payload?.organizations?.[0]?.id;
	if (typeof orgAccountId === "string" && orgAccountId.length > 0) {
		return orgAccountId;
	}
	const rootAccountId = payload?.chatgpt_account_id;
	if (typeof rootAccountId === "string" && rootAccountId.length > 0) {
		return rootAccountId;
	}
	return undefined;
}

function buildOpenAICodexRequestHeaders(
	input: ResolveProviderRequestHeadersInput,
): Record<string, string> | undefined {
	if (input.providerId !== "openai-codex") {
		return undefined;
	}
	const accountId =
		trimNonEmpty(input.openAiCodex?.accountId) ??
		deriveOpenAICodexAccountId(input.openAiCodex?.accessToken);
	const sessionId = trimNonEmpty(input.sessionId);
	return {
		originator: "cline",
		...(sessionId ? { session_id: sessionId } : {}),
		"User-Agent": `Cline/${trimNonEmpty(input.openAiCodex?.userAgentVersion) ?? "1.0.0"}`,
		...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
	};
}

function resolveRequiredProviderHeaders(
	input: ResolveProviderRequestHeadersInput,
): Record<string, string> | undefined {
	if (input.providerId === "opencode-go") {
		const sessionId = trimNonEmpty(input.sessionId);
		return {
			...(sessionId ? { "x-opencode-session": sessionId } : {}),
			"User-Agent": `Cline/${trimNonEmpty(input.client?.version) ?? input.coreVersion}`,
		};
	}
	return (
		buildClineRequestHeaders(input) ?? buildOpenAICodexRequestHeaders(input)
	);
}

function resolveDefaultProviderHeaders(
	headers: ProviderRequestHeaderLayers | undefined,
): Record<string, string> | undefined {
	return headers?.session ?? headers?.config ?? headers?.stored;
}

export function resolveProviderRequestHeaders(
	input: ResolveProviderRequestHeadersInput,
): Record<string, string> | undefined {
	const requiredHeaders = resolveRequiredProviderHeaders(input);
	if (requiredHeaders) {
		return {
			...(input.headers?.stored ?? {}),
			...(input.headers?.config ?? {}),
			...(input.headers?.session ?? {}),
			...(buildSessionIdHeader(input) ?? {}),
			...requiredHeaders,
		};
	}
	return mergeSessionIdHeader(
		resolveDefaultProviderHeaders(input.headers),
		input,
	);
}
